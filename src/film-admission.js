// AIR-369 / ADR 0099 (Accepted), decomposition C3a; ADR 0086 and 0087. D1-owned canonical Film admission for VERIFIED rated-archive Films
// and the watchlist retention fact that keeps a Film after it leaves the current lists. The AIR-499 producer `rated_admission_retention`
// imports this module (bundled). Below the marker `open` both writers refuse before they reach the database; the enrichment projector
// that used to write at r2/prepared was removed in AIR-537 slice 3, so no writer exists below `open`. The R2 object
// letterboxd/admissions/verified-films.json stays the immutable evidence and receipt (never a second mutable owner after a cutover) and the
// enrichment/view-index.json `watchlist` boolean stops being the thing that decides which Films exist. The pre-Film rated-candidate queue is
// not here (AIR-343): only an entry that carries every verification fact becomes a Film.
// - verifiedAdmission validates one receipt entry; nothing else is ever admitted (no title/year match, no short code as an id, no watchlist field).
// - admitRatedFilm / retainFilm are the fenced writers (marker generation + entity revision of schema 13, replay-safe, monotonic).
// - compareAdmissions is the compare-only report of R2 inputs against D1 rows; readRatedAdmissions / readRetention need the marker open.
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';
import {ADMISSION_READ_CHUNK,loadAdmissionRows,readAdmissions} from './canonical-catalog-reader.js';
import {admissionClosedError,admissionRoute,authorityAssertion,d1BatchCondition,legacyBatchCondition,readAdmissionAuthority} from './letterboxd-admission-authority.js';
import {evidenceInsertStatement} from './identity-evidence.js';
import {LID_ONLY_PROOF_VERSION,lidOnlyProofDigest,normalizeFilmUrl} from './domain/letterboxd-lid-only-digest.js';
const writeFenced=fenced.commit;
export const RETENTION_WATERMARK_SCHEMA=25;

export const RATED_RECEIPT_KEY='letterboxd/admissions/verified-films.json';
export {ADMISSION_READ_CHUNK,loadAdmissionRows,readAdmissions};
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
 // AIR-599 / ADR 0207 decision 4b: called through the Letterboxd Sync's fenced env, the admission batch asserts the Sync epoch, so a stale Sync epoch cannot admit.
 const gate=fenced.bindLetterboxdFence(env,assertWritable(await readAuthority(env)));
 // AIR-602 (card A1) / ADR 0207 decision 1: the admission marker is read FRESH at the write. `closed` refuses before any effect; at `d1` the new path of decisions 2 to 6 is the only writer
 // (`admitRatedFilmD1`, a later part of this card); `r2` (and an absent marker: the migration is not applied) is this legacy path, byte-identical to the delivered one except for ONE more
 // statement in its fenced batch: the proof that the marker still says `r2` (or still does not exist) at the generation read, so a legacy admission can never land under `closed` or `d1`.
 const authority=await readAdmissionAuthority(env);
 const route=admissionRoute(authority);
 if(route==='closed')throw admissionClosedError(authority.mode);
 if(route==='d1')return admitRatedFilmD1(env,input,{admission,expected,at,requestId,gate,authority});
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
 statements.push(authorityAssertion(fenced.assertSql,legacyBatchCondition(authority)));
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
 try{await writeFenced(env,gate,statements,entities,tail);}
 catch(error){
  const message=String(error?.cause?.message||'');
  if(error?.code==='film_person_unavailable'&&/UNIQUE constraint failed: film_rated_admission/i.test(message))throw failed('admission_conflict',error);
  throw error;
 }
 return {id,revision:expected+1,admitted:true,replay:false};
}

// AIR-602 (card A1) / ADR 0207 decisions 2 and 3, at the marker mode `d1`: the NEW admission writer. It is `admitRatedFilm` with four differences, all inside the one fenced batch:
// - KEEP-FIRST. An existing row for the same movie id and short code is a no-op whatever the archive, title or year of the new input (`ON CONFLICT DO NOTHING`, never DO UPDATE): the first admitting batch
//   pins archive, title, year and `verified_at`. Another code on the Film (`other_code_on_film`) or a code held by another Film (`code_on_other_film`) is `admission_conflict`, typed through `error.reason`,
//   and the same two conditions are asserted INSIDE the batch, so a concurrent writer cannot turn a no-op into a silent overwrite.
// - PROVENANCE through the evidence ledger (ADR 0213), not a second marker: `input.evidence` is a `planIdentityEvidence` plan and its row is appended to THIS batch (a no-op on an existing key), so the
//   evidence and the admission commit together or not at all. The row stores the fixed `receipt_key = 'd1'`, which says only "not the R2 receipt".
// - The batch asserts the marker is `d1` at the generation the caller read (`d1BatchCondition`), so it can never land under `r2` or `closed`, and a flip back is impossible by the trigger.
// - `verified_at` is the time of the first admitting batch (`at`), not a clock carried by the input: the request identity has no clock in it (see `admissionDigestD1`).
// A replay (the same pair) opens no batch. Owner and reviewed values, credits, metadata, localization, watchlist membership and the rating are never touched.
// input: {receiptKey:'tmdb_<n>', receipt:{tmdb, sourceCode, archiveSha256, title, year, ...}, filmId?, expectedRevision, at, requestId, receiptMark?, evidence?}
export const D1_RECEIPT_KEY='d1';
async function admitRatedFilmD1(env,input,{admission,expected,at,requestId,gate,authority}){
 const condition=d1BatchCondition(authority);
 const db=database(env);
 let target,prior,holder;
 try{
  target=await resolveAdmissionFilm(env,admission.tmdb);
  prior=await one(db,'SELECT tmdb,source_code FROM film_rated_admission WHERE film_id=?',[target.id]);
  holder=await one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[admission.sourceCode]);
 }catch(error){if(unavailable(error)||/no such table/i.test(String(error?.message||'')))throw failed('admission_unavailable',error);throw error;}
 if(input.filmId!==undefined&&input.filmId!==target.id)throw failed('admission_target_changed');
 if(target.redirected)throw failed('film_person_redirect');
 if(target.held){const error=failed('admission_identity_held');error.reason=target.held;throw error;}
 const conflict=reason=>{const error=failed('admission_conflict');error.reason=reason;return error;};
 // AIR-672 / ADR 0217 decision 5b: a lid-only Film for this lid (`film_lid_admission`) is never attached or duplicated by a TMDB-proved admission. The planner answers it before any link; this is the in-batch
 // predicate (`lid_only_present`). While migration 0047 is not applied the table does not exist: the batch then asserts that it STILL does not (a table applied in between fails the batch and replans), so the
 // TMDB path is byte-identical in behaviour at every schema that has no lid-only Film.
 let lidAdmission=false;
 try{
  lidAdmission=await hasLidAdmissionTable(db);
  if(lidAdmission&&await one(db,'SELECT 1 AS present FROM film_lid_admission WHERE lid=?',[admission.sourceCode]))throw conflict('lid_only_present');
 }catch(error){if(error?.code==='admission_conflict')throw error;if(unavailable(error)||/no such table/i.test(String(error?.message||'')))throw failed('admission_unavailable',error);throw error;}
 if(holder&&holder.film_id!==target.id)throw conflict('code_on_other_film');
 if(prior){
  if(prior.tmdb!==admission.tmdb||prior.source_code!==admission.sourceCode)throw conflict('other_code_on_film');
  // Keep-first: the same pair is admitted already. Nothing is written and nothing is overwritten.
  return {id:target.id,revision:target.revision,admitted:false,replay:true,present:true};
 }
 const id=target.id;
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push(authorityAssertion(fenced.assertSql,condition));
 statements.push([fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id]]);
 statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='tmdb' AND value=? AND NOT (film_id IS ? AND trusted=1 AND conflicting=0))"),[admission.tmdb,target.owner]]);
 statements.push([fenced.assertSql("(SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)=?"),[admission.tmdb,target.owner?1:0]]);
 statements.push(["INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_identity=COALESCE(film.canonical_identity,excluded.canonical_identity),original_title=COALESCE(film.original_title,excluded.original_title),updated_at=excluded.updated_at",[id,'tmdb:'+admission.tmdb,admission.title,at]]);
 statements.push(["INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,'tmdb',?,1,0,?) ON CONFLICT(film_id,scheme,value) DO NOTHING",[id,admission.tmdb,stable({source:'letterboxd_rated_admission',receiptKey:D1_RECEIPT_KEY})]]);
 statements.push(["INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES (?,'letterboxd_short_code',?,?) ON CONFLICT(film_id,kind,value) DO NOTHING",[id,admission.sourceCode,stable({source:'letterboxd_rated_admission',receiptKey:D1_RECEIPT_KEY})]]);
 statements.push(["INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO NOTHING",[id,admission.tmdb,admission.sourceCode,admission.archiveSha256,admission.title,admission.year,D1_RECEIPT_KEY,admission.receiptFilmKey,at,requestId,at]]);
 // Keep-first and the typed conflicts are enforced IN the batch: the insert never updates (`DO NOTHING`), a code held by another Film violates the unique index (typed `code_on_other_film` below), and the
 // batch's own admission row must exist and be this request's, so a row that appeared after the read above (another code on the Film, an earlier admission of the pair) fails the whole batch instead of being
 // overwritten or silently kept. With the revision compare-and-swap, a receipt is applied only by the batch that wrote its admission.
 statements.push([fenced.assertSql('EXISTS (SELECT 1 FROM film_rated_admission WHERE film_id=? AND source_code=? AND request_id=?)'),[id,admission.sourceCode,requestId]]);
 statements.push(lidAdmission?[fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_lid_admission WHERE lid=?)'),[admission.sourceCode]]:[fenced.assertSql("NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='film_lid_admission')"),[]]);
 if(input.evidence!==undefined&&input.evidence!==null)statements.push(evidenceInsertStatement(input.evidence,{filmId:id,requestId,at}));
 statements.push([fenced.BUMP,['film',id,at]]);
 try{
  await writeFenced(env,gate,statements,entities,tail);
 }
 catch(error){
  const message=String(error?.cause?.message||'');
  if(error?.code==='film_person_unavailable'&&/UNIQUE constraint failed: film_rated_admission/i.test(message))throw conflict(/source_code/.test(message)?'code_on_other_film':'other_code_on_film');
  // The batch's own keep-first assertion refused it (a row for this Film or this code appeared after the reads above): classify by reading what is there now, so the refusal is a typed outcome and not a crash.
  // Anything that is not one of the two typed conflicts (a moved revision, the same pair already admitted, an unreadable table) is rethrown unchanged.
  if(error?.code==='film_person_precondition'){
   let now;
   try{now={holder:await one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[admission.sourceCode]),prior:await one(db,'SELECT tmdb,source_code FROM film_rated_admission WHERE film_id=?',[target.id])};}catch{throw error;}
   if(lidAdmission){try{if(await one(db,'SELECT 1 AS present FROM film_lid_admission WHERE lid=?',[admission.sourceCode]))throw conflict('lid_only_present');}catch(inner){if(inner?.code==='admission_conflict')throw inner;}}
   if(now.holder&&now.holder.film_id!==target.id)throw conflict('code_on_other_film');
   if(now.prior&&(now.prior.tmdb!==admission.tmdb||now.prior.source_code!==admission.sourceCode))throw conflict('other_code_on_film');
  }
  throw error;
 }
 return {id,revision:expected+1,admitted:true,replay:false};
}

// AIR-672 / ADR 0217 (Accepted) decisions 1, 4, 5b, 5c and 7 (delivery step 3), DORMANT: the lid-only Film. A verified Letterboxd film page with a positively absent TMDB relation (H1, `lidOnlyPageProof`) is admitted as the
// canonical Film `film:lb:<lid>` (a minting id, I1: a stable entity key, never a current identity), its trusted `letterboxd` claim and the immutable proof row `film_lid_admission` (K2: no evidence row, the proof
// is recomputable from its columns). Nothing calls it from a live path: it is reachable only through `admitVerifiedLidOnly` (letterboxd-admission-d1.js) at the admission marker `d1`, and refuses before its first
// effect at `r2` and `closed` and while migration 0047 is not applied. Every caller passes the proof it received from the page check; the writer recomputes the digest and never trusts a column.
export const LID_ONLY_FILM_PREFIX='film:lb:';
export const LID_ONLY_ROUTES=Object.freeze(['watchlist_admission','ratings_diary','letterboxd_rated_archive']);
const LID_CODE=/^[A-Za-z0-9_-]{1,80}$/;
export const lidOnlyFilmId=lid=>{if(typeof lid!=='string'||!LID_CODE.test(lid))throw failed('film_person_invalid');return LID_ONLY_FILM_PREFIX+lid;};
export async function hasLidAdmissionTable(db){return !!(await one(db,"SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='film_lid_admission'"));}
// The `links.json` document the caller read: its parts and etag (ADR 0217 decision 5b, "the Ratings link document itself"). The epoch alone is a lease fence, not a version of this document. {key, parts, etag}; an absent
// document is `parts: 0`. -> one [sql, params] boolean: the part count and the single etag of the stored parts still equal what was read.
export function ratingsDocumentFence(fence){
 if(!plain(fence)||typeof fence.key!=='string'||!fence.key||!Number.isInteger(fence.parts)||fence.parts<0)throw failed('film_person_invalid');
 if(fence.parts===0)return ['(SELECT COUNT(*) FROM ratings_document WHERE key=?)=0',[fence.key]];
 if(typeof fence.etag!=='string'||!fence.etag)throw failed('film_person_invalid');
 return ['(SELECT COUNT(*) FROM ratings_document WHERE key=?)=? AND (SELECT COUNT(DISTINCT etag) FROM ratings_document WHERE key=?)=1 AND (SELECT MIN(etag) FROM ratings_document WHERE key=?)=?',[fence.key,fence.parts,fence.key,fence.key,fence.etag]];
}
async function checkedLidOnlyProof(lid,proof){
 const bad=reason=>{const error=failed('admission_not_verified');error.reason=reason;return error;};
 if(!plain(proof)||proof.lid!==lid||proof.shortlink!==lid)throw bad('proof_invalid');
 if(proof.proofVersion!==LID_ONLY_PROOF_VERSION||proof.idBlockOutcome!=='absent'||proof.completenessOutcome!=='complete')throw bad('proof_invalid');
 if(proof.pageStatus!==200||!Number.isInteger(proof.redirectStatus)||proof.redirectStatus<300||proof.redirectStatus>399)throw bad('proof_invalid');
 if(typeof proof.title!=='string'||!proof.title.trim()||proof.title!==proof.title.trim()||typeof proof.typeMarker!=='string'||!proof.typeMarker)throw bad('proof_invalid');
 if(proof.year!==null&&!(Number.isInteger(proof.year)&&proof.year>=1800&&proof.year<=2200))throw bad('proof_invalid');
 const url=normalizeFilmUrl(proof.finalUrl);
 if(!url||url!==proof.finalUrl||url!=='https://letterboxd.com'+proof.canonicalPath||proof.canonicalPath!=='/film/'+proof.slug+'/')throw bad('proof_invalid');
 if(typeof proof.checkedAt!=='string'||!ISO.test(proof.checkedAt))throw bad('proof_invalid');
 if(!HEX64.test(String(proof.proofDigest))||await lidOnlyProofDigest(proof)!==proof.proofDigest)throw bad('proof_digest_mismatch');
 return proof;
}
// input: {lid, route, proof, expectedRevision, at, requestId, receiptMark, linksFence?:{key, parts, etag}, filmId?}. -> {id, revision, admitted:true}. Typed refusals (`error.reason`):
//   `admission_conflict` with `lid_claim_present` (a `letterboxd` claim of the lid of ANY trust on any Film), `film_id_taken`, `lid_admission_present`, `rated_admission_present`;
//   `film_person_redirect` (a redirect from the id), `admission_unavailable` (migration 0047 is not applied). The same conditions are asserted INSIDE the batch.
export async function admitLidOnlyFilm(env,input){
 const lid=input?.lid;
 const id=lidOnlyFilmId(lid);
 if(!LID_ONLY_ROUTES.includes(input.route))throw failed('film_person_invalid');
 const expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 if(input.filmId!==undefined&&input.filmId!==id)throw failed('admission_target_changed');
 const proof=await checkedLidOnlyProof(lid,input.proof);
 const gate=fenced.bindLetterboxdFence(env,assertWritable(await readAuthority(env)));
 // The marker is read FRESH at the write. Only `d1` admits a lid-only Film: `closed` and `r2` (and an absent marker) refuse before the first effect (decision 5).
 const authority=await readAdmissionAuthority(env);
 const route=admissionRoute(authority);
 if(route!=='d1')throw admissionClosedError(authority.mode);
 const condition=d1BatchCondition(authority);
 const db=database(env);
 let state;
 try{
  if(!await hasLidAdmissionTable(db))throw failed('admission_unavailable',new Error('film_lid_admission_missing'));
  state=await Promise.all([one(db,'SELECT id FROM film WHERE id=?',[id]),one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]),one(db,"SELECT film_id FROM film_external_id WHERE scheme='letterboxd' AND value=?",[lid]),
   one(db,'SELECT film_id FROM film_lid_admission WHERE lid=?',[lid]),one(db,'SELECT film_id FROM film_rated_admission WHERE source_code=?',[lid])]);
 }catch(error){if(error?.code==='admission_unavailable')throw error;if(unavailable(error)||/no such table/i.test(String(error?.message||'')))throw failed('admission_unavailable',error);throw error;}
 const conflict=reason=>{const error=failed('admission_conflict');error.reason=reason;return error;};
 if(state[1])throw failed('film_person_redirect');
 if(state[0])throw conflict('film_id_taken');
 if(state[2])throw conflict('lid_claim_present');
 if(state[3])throw conflict('lid_admission_present');
 if(state[4])throw conflict('rated_admission_present');
 const tail=fenced.receiptTail(input.receiptMark,{kind:'film',id});
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push(authorityAssertion(fenced.assertSql,condition));
 // The symmetric predicates of decision 5b: the durable state this batch is the only writer of.
 statements.push([fenced.assertSql('NOT EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id,id]]);
 statements.push([fenced.assertSql("NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme='letterboxd' AND value=?)"),[lid]]);
 statements.push([fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_lid_admission WHERE lid=?) AND NOT EXISTS (SELECT 1 FROM film_rated_admission WHERE source_code=?)'),[lid,lid]]);
 if(input.linksFence!==undefined&&input.linksFence!==null){const [sql,params]=ratingsDocumentFence(input.linksFence);statements.push([fenced.assertSql(sql),params]);}
 statements.push(["INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,1,NULL,?,?)",[id,proof.title,at]]);
 statements.push(["INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (?,'letterboxd',?,1,0,?)",[id,lid,stable({source:input.route,adr:'0217',evidence:proof.proofDigest})]]);
 statements.push(["INSERT INTO film_lid_admission (lid,film_id,route,admitted_at,receipt_key,proof_version,final_url,slug,canonical_path,shortlink,type_marker,id_block_outcome,completeness_outcome,title,year,proof_digest,checked_at,redirect_status,page_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  [lid,id,input.route,at,'admission:lid:'+lid,proof.proofVersion,proof.finalUrl,proof.slug,proof.canonicalPath,proof.shortlink,proof.typeMarker,proof.idBlockOutcome,proof.completenessOutcome,proof.title,proof.year,proof.proofDigest,proof.checkedAt,proof.redirectStatus,proof.pageStatus]]);
 statements.push([fenced.BUMP,['film',id,at]]);
 try{
  await writeFenced(env,gate,statements,entities,tail);
 }
 catch(error){
  const message=String(error?.cause?.message||'');
  if(error?.code==='identity_collision'||(error?.code==='film_person_unavailable'&&/UNIQUE constraint failed: film_lid_admission/i.test(message)))throw conflict('lid_admission_present');
  throw error;
 }
 return {id,revision:expected+1,admitted:true,replay:false,lidOnly:true};
}

// The fenced write of the watchlist retention fact for ONE existing Film (ADR 0086: a Film stays after it leaves the lists). It never creates
// a Film and never reads or writes membership (watchlist_film). The row is a monotonic fact: a newer observation replaces the older one, an
// older or equal one is skipped, a replay with the same request id and content opens no batch.
// input: {id, expectedRevision, at, requestId, watchlist:boolean, observedAt, evidence?:object, watermark?:true}
// `watermark: true` (the scan watermark table exists, schema 25) adds one assertion to the batch: the observation must not be older than film_retention_scan.
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
 // AIR-532 (ADR 0173): with the scan watermark present, an observation older than it is refused in the SAME fenced batch, so a late contradictory observation cannot land between the caller's plan and this write.
 if(input.watermark===true)statements.push([fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_retention_scan WHERE id=1 AND observed_at>?)'),[observed]]);
 statements.push(["INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES (?,'watchlist_fact',?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET watchlist=excluded.watchlist,evidence_json=excluded.evidence_json,request_id=excluded.request_id,observed_at=excluded.observed_at,updated_at=excluded.updated_at WHERE excluded.observed_at>film_retention.observed_at",[id,input.watchlist?1:0,evidence,requestId,observed,at]]);
 statements.push([fenced.BUMP,['film',id,at]]);
 await writeFenced(env,gate,statements,entities,tail);
 return {id,revision:expected+1,retained:true,written:true};
}

// AIR-532 / ADR 0173. The scan watermark: ONE row (schema 25, `film_retention_scan`) with the observation time of the newest admitted complete scan.
// `film_retention.observed_at` is the start of a Film's current state, so it cannot order a late observation against a later unchanged confirmation;
// this row can. While the table is absent (schema below 25) `present` is false and the producer keeps the previous behaviour.
export async function readRetentionWatermark(env){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 try{
  const row=await one(db,'SELECT observed_at FROM film_retention_scan WHERE id=1');
  return {present:true,observedAt:row?.observed_at??null};
 }catch(error){
  if(!/no such table/i.test(String(error?.cause?.message||error?.message||error)))throw failed('film_person_unavailable',error);
  // The table is absent. That is the legitimate pre-migration state ONLY while the schema is genuinely below 25. At schema 25 or later it is a missing or damaged
  // watermark table, and falling back to row-only ordering would silently reopen the stale-overwrite hole: fail closed.
  let version;
  try{version=Number((await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version);}
  catch(inner){throw failed('film_person_unavailable',inner);}
  if(Number.isFinite(version)&&version<RETENTION_WATERMARK_SCHEMA)return {present:false,observedAt:null};
  throw failed('film_person_unavailable',new Error('film_retention_scan_missing_at_schema_'+version));
 }
}
// Moves the watermark forward to `observedAt` (never back: the statement and a trigger both refuse), in a fenced batch (marker generation asserted).
// Returns the watermark as it stands afterwards. A scan advances it once; later slices of the same scan read it and write nothing.
export async function advanceRetentionWatermark(env,{observedAt,at}={}){
 const observed=instant(observedAt),stamp=fenced.text(at);
 if(!observed)throw failed('retention_invalid');
 const gate=assertWritable(await readAuthority(env));
 await writeFenced(env,gate,[["INSERT INTO film_retention_scan (id,observed_at,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,updated_at=excluded.updated_at WHERE excluded.observed_at>film_retention_scan.observed_at",[observed,stamp]]],[],[]);
 return readRetentionWatermark(env);
}

// The two D1 readers (loadAdmissionRows, readAdmissions) live in canonical-catalog-reader.js, the one import-free read module the Worker bundles (AIR-374 P4);
// they are re-exported here so every existing caller and test keeps this path.

// Compare-only (inactive): the R2 inputs (verified-films.json body, view-index body) against D1 rows keyed by the same movie id / lid. Nothing is
// written. `receipts` entries that are not verified are listed as `unverified` and are never expected in D1. Each list is capped.
// rows: {admissions:[{filmId,tmdb,sourceCode,archiveSha256}], retained:[{filmId,letterboxdIds:[...]}]}
const ADMISSION_LID=/^[A-Za-z0-9_-]{1,80}$/;
const ARCHIVE_FILM=/^tmdb_[1-9]\d{0,11}$/;
function watchlistAdmissionsFromIndex(index){
 const out={};
 if(!index||typeof index!=='object'||Array.isArray(index))return out;
 for(const [id,item] of Object.entries(index)){
  if(!ADMISSION_LID.test(id)||id.startsWith('tmdb_')||!item||typeof item.watchlist!=='boolean')continue;
  out[id]=item.watchlist;
 }
 return out;
}
function archiveAdmissionsFromDocument(document){
 const out={};
 if(!document||document.schemaVersion!==1||!document.films||typeof document.films!=='object'||Array.isArray(document.films))return out;
 for(const [id,item] of Object.entries(document.films)){
  if(!ARCHIVE_FILM.test(id)||!item||typeof item!=='object'||Array.isArray(item))continue;
  if(Object.prototype.hasOwnProperty.call(item,'watchlist'))continue;
  if(String(item.tmdb)!==id.slice(5))continue;
  out[id]={tmdb:String(item.tmdb)};
 }
 return out;
}
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
