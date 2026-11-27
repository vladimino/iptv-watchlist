// ADR 0084, ADR 0162. Diary facts, confirmed ratings, the ratings run and the
// removal queue are D1-owned, and the domain is served only while
// ratings_domain_authority is mode d1 with cutover open. A marker in mode r2
// (the migration's inserted value) or a missing or invalid marker fails closed;
// so does mode d1 with cutover held, for readers as well as writers, so no
// reader falls back to stale R2 copies. Some but not all of these tables fails
// closed. With RATINGS_DB_REQUIRED=on (production) a missing binding, schema or
// domain tables fails closed too; without it (local development and the test
// harness, the domain's explicit stand-in) the domain is not installed and the
// callers keep the R2 objects. Mode d1 with cutover open does not fall back to R2. The view index in R2 is not a rating source
// once that marker is open: watched, actualRating and watchlist are replaced
// from ratings_view. A film-record compare-and-swap writes that projection in
// the same batch. Events stay in R2 as a projection of a confirmed rating.
// Archive receipts, ZIP bytes and HTML snapshots stay in R2.
// This module does not import. The Worker bundle wraps it.

export const DOCUMENT_BYTES=60000;
export const CONTRACT=10;
// Keyset pages, same bound as the prediction overlay: D1 `.all()` without LIMIT is not a complete table.
export const RATINGS_OVERLAY_PAGE=300;
export const RATINGS_OVERLAY_ROWS=20000;
const FENCE_SQL='UPDATE ratings_domain_cas SET ok=changes() WHERE id=1';
const TABLES=['ratings_domain_authority','ratings_domain_cas','ratings_document','ratings_view'];
const EXACT=new Set([
 'letterboxd/facts/links.json',
 'letterboxd/facts/conflicts.json',
 'letterboxd/diary/history.json',
 'letterboxd/diary/state.json',
 'letterboxd/ratings/run.json',
 'letterboxd/ratings/migration.json',
 // AIR-347 / ADR 0089: the executor mode and epoch (written only by the owner's mode switch) and the executor's control record.
 'letterboxd/ratings/executor.json',
 'letterboxd/ratings/orchestration.json',
 'enrichment/removal-rating-lookups.json',
]);

export function ratingsMutableKey(key){
 if(typeof key!=='string'||!key||key.includes('..')||key.startsWith('/'))return false;
 if(EXACT.has(key))return true;
 if(key.startsWith('letterboxd/facts/films/')&&key.endsWith('.json')&&key.length<240)return true;
 if(key.startsWith('letterboxd/facts/scans/')&&key.endsWith('.json')&&key.length<240)return true;
 return false;
}

// ADR 0222: the Letterboxd import coordination documents (rated candidates, inferred chunk intent, receipt and candidates result) are D1 documents ONLY under an explicit `admission` option, which a caller passes
// only after it read marker `d1` of `letterboxd_admission_authority` (and asserts that marker in the same batch). They are deliberately NOT in `ratingsMutableKey`, so no existing Ratings route changes.
const ADMISSION_DOCUMENT=/^letterboxd\/imports\/(?:documents-manifest\.json|[0-9a-f]{64}\/(?:rated-candidates\.json|chunks\/[0-9]{1,6}\.(?:intent|receipt|candidates)\.json))$/;
// Concrete bound, in BYTES of the stored JSON: the store partitions a document into parts of DOCUMENT_BYTES and writes every part in ONE batch (plus the guards); 4,000,000 bytes is at most 67 parts, far below the
// 950 statements per request this repository already respects for D1. A larger document would need the partitioned write split across batches, which is not atomic: it is refused, never truncated.
export const ADMISSION_DOCUMENT_BYTES=4000000;
export function admissionDocumentKey(key){return typeof key==='string'&&key.length<240&&ADMISSION_DOCUMENT.test(key);}
function ownsKey(key,admission){return admission===true?admissionDocumentKey(key):ratingsMutableKey(key);}
function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function binding(db){return typeof db?.prepare==='function';}
function database(env){return env&&typeof env.prepare==='function'?env:env?.DB;}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
async function one(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).first())??null;
 return (await db.get(sql,params))??null;
}
async function many(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).all()).results||[];
 return (await db.all(sql,params))||[];
}
async function fenced(db,statements){
 if(typeof db.batch!=='function')throw failed('ratings_domain_unavailable');
 if(statements.some(([,params])=>params.length>100))throw failed('ratings_domain_unavailable');
 const prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));
 try{await db.batch(prepared);}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message))throw failed('ratings_domain_fence',error);
  throw failed('ratings_domain_unavailable',error);
 }
}
async function digest(text){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function splitText(text){
 const encoded=new TextEncoder().encode(text);
 const parts=[];
 let start=0;
 while(start<encoded.length){
  let end=Math.min(encoded.length,start+DOCUMENT_BYTES);
  if(end<encoded.length){while(end>start&&(encoded[end]&0b11000000)===0b10000000)end--;if(end===start)throw failed('ratings_domain_unavailable');}
  parts.push(new TextDecoder().decode(encoded.subarray(start,end)));
  start=end;
 }
 if(!parts.length)parts.push('');
 return parts;
}
function idle(version,bindingPresent){
 return {mode:'r2',cutover:null,tables:false,version,ready:false,binding:bindingPresent,generation:0};
}
function authorityWhere(){
 return "EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND mode=? AND cutover='open')";
}

export async function readRatingsAuthority(db,env){
 if(db==null){
  if(env?.RATINGS_DB_REQUIRED==='on')throw failed('ratings_domain_unavailable');
  return idle(null,false);
 }
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error))){
   if(env?.RATINGS_DB_REQUIRED==='on')throw failed('ratings_domain_unavailable');
   return idle(null,true);
  }
  throw failed('ratings_domain_unavailable',error);
 }
 if(version==null){
  if(env?.RATINGS_DB_REQUIRED==='on')throw failed('ratings_domain_unavailable');
  return idle(null,true);
 }
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")")).map(row=>row.name);}
 catch(error){throw failed('ratings_domain_unavailable',error);}
 const present=TABLES.filter(name=>names.includes(name)).length;
 if(present===0){
  if(env?.RATINGS_DB_REQUIRED==='on')throw failed('ratings_domain_unavailable');
  return idle(Number(version),true);
 }
 if(present!==TABLES.length||Number(version)<CONTRACT)throw failed('ratings_domain_unavailable');
 let row;
 try{row=await one(db,"SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1");}
 catch(error){throw failed('ratings_domain_unavailable',error);}
 // ADR 0162: only mode d1 is served; a marker left in or restored to mode r2 is refused.
 if(!row||row.mode!=='d1'||(row.cutover!=='open'&&row.cutover!=='held'))throw failed('ratings_domain_unavailable');
 const generation=Number(row.generation);
 return {mode:row.mode,cutover:row.cutover,tables:true,version:Number(version),ready:row.mode==='d1'&&row.cutover==='open',binding:true,generation};
}

export async function ratingsReady(env){
 return (await readRatingsAuthority(database(env),env)).ready===true;
}

// The generation the ZIP preview fences. A broken marker is an error, not an R2 fallback.
export async function ratingsGate(env){
 try{
  const authority=await readRatingsAuthority(database(env),env);
  return {ready:authority.ready===true,generation:authority.ready?authority.generation:null,error:false,held:authority.tables===true&&authority.ready!==true};
 }catch{return {ready:false,generation:null,error:true,held:false};}
}

async function requireOpen(env){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(authority.tables&&!authority.ready)throw failed('ratings_domain_not_authoritative');
 if(!authority.tables)return {authority,db,open:false};
 return {authority,db,open:true};
}

async function readParts(db,key){
 const rows=await many(db,'SELECT part, body, etag FROM ratings_document WHERE key=? ORDER BY part',[key]);
 if(!rows.length)return {value:null,etag:null,text:null,parts:0};
 const etag=rows[0].etag;
 if(rows.some((row,index)=>Number(row.part)!==index||row.etag!==etag))throw failed('ratings_domain_unavailable');
 const text=rows.map(row=>row.body).join('');
 if(await digest(text)!==etag)throw failed('ratings_domain_unavailable');
 let value;
 try{value=JSON.parse(text);}catch(error){throw failed('ratings_domain_unavailable',error);}
 return {value,etag,text,parts:rows.length};
}

export async function readOwned(env,key,{admission=false}={}){
 if(!ownsKey(key,admission))return {owned:false};
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 // A held marker is not authority and is not a reason to read R2 (ADR 0162); an uninstalled domain is the local stand-in.
 if(authority.tables&&!authority.ready)throw failed('ratings_domain_not_authoritative');
 if(!authority.ready)return {owned:false};
 const document=await readParts(db,key);
 return {owned:true,value:document.value,etag:document.etag};
}

// AIR-673 / ADR 0217 decision 5b: a POSITIVE observation of an owned document, with the exact fence of the parts read (`{key, parts, etag}`; zero parts for a proven absent document). Read only. {owned:false} outside the `d1` domain.
export async function observeOwned(env,key){
 if(!ownsKey(key,false))return {owned:false};
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(authority.tables&&!authority.ready)throw failed('ratings_domain_not_authoritative');
 if(!authority.ready)return {owned:false};
 const document=await readParts(db,key);
 return {owned:true,value:document.value,fence:{key,parts:document.parts,etag:document.etag}};
}

export async function routeRead(env,key){
 const owned=await readOwned(env,key);
 if(!owned.owned)return {handled:false};
 return {handled:true,value:owned.value};
}

function writeStatements(key,text,etag,now,previousEtag,mode){
 const parts=splitText(text);
 const statements=[];
 if(previousEtag==null){
  statements.push(['INSERT INTO ratings_document (key, part, body, etag, updated_at) SELECT ?, 0, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ratings_document WHERE key=?) AND '+authorityWhere(),[key,parts[0],etag,now,key,mode]]);
  statements.push([FENCE_SQL,[]]);
  for(let part=1;part<parts.length;part++)statements.push(['INSERT INTO ratings_document (key, part, body, etag, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ratings_document WHERE key=? AND part=0 AND etag=?)',[key,part,parts[part],etag,now,key,etag]]);
 }else{
  statements.push(['DELETE FROM ratings_document WHERE key=? AND etag=? AND '+authorityWhere(),[key,previousEtag,mode]]);
  statements.push([FENCE_SQL,[]]);
  for(let part=0;part<parts.length;part++)statements.push(['INSERT INTO ratings_document (key, part, body, etag, updated_at) VALUES (?,?,?,?,?)',[key,part,parts[part],etag,now]]);
 }
 statements.push(["UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1 AND mode=? AND cutover='open'",[mode]]);
 return statements;
}

// AIR-347 / ADR 0089 decision 2a. An executor's env carries `ratingsFence: {key, etag}`: the document that holds the executor
// mode and epoch, and the etag it had when the step was admitted. Every authoritative commit made through such an env asserts
// in its own batch that this document is unchanged, so a commit from a stale epoch or mode is refused with the data.
// AIR-599 (fifth and sixth review of PR #1009): an env may carry `effectGuard: {sql, params}`, the check reservation of a Letterboxd identity effect (built by `LetterboxdFacts.reservationGuard`: a boolean over the
// reconstructed check document, boundary-safe across its parts). Every Ratings commit made through it asserts that in its own batch, so an effect whose reservation was released, taken over or voided by an owner action
// is refused at commit, not merely not started. Internal code only, never request input.
const RESERVATION_SQL=/^\(EXISTS \(SELECT 1 FROM ratings_document WHERE key=\? AND instr\(body,\?\)>0\) OR EXISTS \(SELECT 1 FROM ratings_document a JOIN ratings_document b /;
function effectGuardStatements(env){
 const guard=env?.effectGuard;
 if(guard===undefined||guard===null)return [];
 if(typeof guard.sql!=='string'||!RESERVATION_SQL.test(guard.sql)||!Array.isArray(guard.params)||guard.params.length!==6)throw failed('ratings_domain_fence');
 return [["UPDATE ratings_domain_cas SET ok=CASE WHEN "+guard.sql+" THEN 1 ELSE 0 END WHERE id=1",guard.params]];
}
// ADR 0222 / PR #1018 review: an env may carry `admissionGuards`, the operation-history assertions (`guard.statement` of the Letterboxd admission coordinator) of the identity the caller observed. Every Ratings commit made through it
// asserts them in its own batch, so an irreversible effect (a link, a fact, a claim) planned against a history that has since moved is refused whole, never half done. Internal code only, never request input; only that
// exact assertion shape is accepted.
// AIR-672 / ADR 0217 decision 5b: the same carrier also accepts, and only in its exact shape, the OWNED-ATTEMPT assertion of `ownedAttemptCondition` (the receipt of the key is `pending` with this request id and attempt, and its window has not passed AT THE TIME THE DATABASE EXECUTES the batch).
const ADMISSION_GUARD=/^INSERT INTO film_person_cas \(id,ok\) VALUES \(1,\(SELECT CASE WHEN EXISTS \(SELECT 1 FROM film_person_cas WHERE id=1\) AND (?:\(\(SELECT COUNT\(\*\) FROM canonical_write_receipt WHERE origin=\? AND operation_key=\?\)=\? AND |\(EXISTS \(SELECT 1 FROM canonical_write_receipt WHERE origin=\? AND operation_key=\? AND request_id=\? AND state='pending' AND attempts=\? AND next_attempt_at>strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)\)\) THEN 1 ELSE 0 END\)\) ON CONFLICT\(id\) DO UPDATE SET ok=excluded\.ok$)/;
function admissionGuardStatements(env){
 const list=env?.admissionGuards;
 if(list===undefined||list===null)return [];
 if(!Array.isArray(list)||list.length>64)throw failed('ratings_domain_fence');
 return list.map(entry=>{
  // AIR-672: an item may be a function, called each time a batch is built, so a deadline is compared with the time of the effect and not with a time frozen earlier.
  const item=typeof entry==='function'?entry():entry;
  if(!Array.isArray(item)||typeof item[0]!=='string'||!ADMISSION_GUARD.test(item[0])||!Array.isArray(item[1])||item[1].length>100)throw failed('ratings_domain_fence');
  return [item[0],item[1]];
 });
}
function epochFence(env){return [...epochFenceBase(env),...effectGuardStatements(env),...admissionGuardStatements(env)];}
function epochFenceBase(env){
 const fence=env?.ratingsFence;
 if(!fence)return [];
 // AIR-570 / ADR 0186: the Letterboxd Sync fences its Diary writes with its own mode epoch: a caller-supplied guard statement (a [sql, params] pair that trips a CHECK when the epoch no longer holds) rides in the same batch.
 if(fence.guard!==undefined){
  if(!Array.isArray(fence.guard)||typeof fence.guard[0]!=='string'||!Array.isArray(fence.guard[1]))throw failed('ratings_domain_fence');
  return [fence.guard];
 }
 if(typeof fence.key!=='string'||!(fence.etag===null||(typeof fence.etag==='string'&&fence.etag)))throw failed('ratings_domain_fence');
 // `etag: null` asserts that the mode document does not exist yet (the default external mode). ok=0 trips the CHECK (ok >= 1).
 const statements=[["UPDATE ratings_domain_cas SET ok=CASE WHEN (SELECT COUNT(*) FROM ratings_document WHERE key=? AND part=0 AND (? IS NULL OR etag=?))=? THEN 1 ELSE 0 END WHERE id=1",[fence.key,fence.etag,fence.etag,fence.etag===null?0:1]]];
 // AIR-571 D: the Letterboxd mode revision the admission saw. A close, completion or abort of the Letterboxd mode after the admission rejects this commit, so an already admitted legacy request cannot write over the new owner.
 if(fence.letterboxdRevision!==undefined){
  if(!Number.isInteger(fence.letterboxdRevision))throw failed('ratings_domain_fence');
  // Both the revision AND the mode: the row is still the `external` one that was read (an absent row only for the initial default, revision 0).
  statements.push(["UPDATE ratings_domain_cas SET ok=CASE WHEN COALESCE((SELECT revision FROM letterboxd_sync_mode WHERE id=1),0)=? AND (NOT EXISTS (SELECT 1 FROM letterboxd_sync_mode WHERE id=1) OR (SELECT mode FROM letterboxd_sync_mode WHERE id=1)='external')"+(fence.watchlistGuard===true?" AND (COALESCE((SELECT epoch FROM letterboxd_sync_mode WHERE id=1),0)=0 OR (SELECT COUNT(*) FROM watchlist_authority WHERE id=1 AND mode='epg' AND writes='open')=1)":"")+" THEN 1 ELSE 0 END WHERE id=1",[fence.letterboxdRevision]]);
 }
 return statements;
}

// `saved` keeps its meaning for every caller (the stored etag, or null). AIR-559 adds an explicit, backward-compatible account of WHY it is null, for a caller that must not
// confuse a rollback with a write: `refused: true` when a fence or guard of the batch did not hold (the batch rolled back, nothing was written), `committed: true`
// when the batch committed but the read-back found another etag (a later write replaced it; the write happened). A read-back that throws after a committed
// batch is rethrown with `ratingsCommitted: true` on the error, so such a caller can tell it from a failure before or during the batch.
export async function putOwned(env,key,previousEtag,value,{extra=[],admission=false}={}){
 if(!ownsKey(key,admission))return {owned:false};
 const mode='d1';
 const gate=await requireOpen(env);
 if(!gate.open)return {owned:false};
 const text=JSON.stringify(value);
 if(admission===true&&new TextEncoder().encode(text).length>ADMISSION_DOCUMENT_BYTES)throw failed('admission_document_too_large');
 const etag=await digest(text);
 const now=new Date().toISOString();
 const statements=writeStatements(key,text,etag,now,previousEtag,mode);
 const bump=statements.pop();
 try{await fenced(gate.db,[...statements,...(extra||[]),...epochFence(env),bump]);}
 catch(error){
  if(error.code==='ratings_domain_fence')return {owned:true,saved:null,refused:true};
  throw error;
 }
 let stored;
 try{stored=await readParts(gate.db,key);}
 catch(error){if(error&&typeof error==='object')error.ratingsCommitted=true;throw error;}
 if(stored.etag!==etag)return {owned:true,saved:null,committed:true};
 return {owned:true,saved:{etag}};
}

// AIR-599 (review of PR #1009): `extra` is a list of caller [sql, params] statements that ride in the SAME batch as the document write (and are rolled back with it), for a write that must be atomic with another D1 table.
export async function casOwned(env,key,empty,apply,{extra:callerExtra=[],admission=false}={}){
 if(!ownsKey(key,admission))return {owned:false};
 const gate=await requireOpen(env);
 if(!gate.open)return {owned:false};
 for(let attempt=0;attempt<5;attempt++){
  const current=await readParts(gate.db,key);
  const base=current.value??clone(empty);
  const next=await apply(clone(base),current.etag);
  if(next==null)return {owned:true,result:{value:base,changed:false}};
  const extra=[...(key.startsWith('letterboxd/facts/films/')?await viewWrites(gate.db,[next]):[]),...callerExtra];
  const saved=await putOwned(env,key,current.etag,next,{extra,admission});
  if(!saved.owned)throw failed('ratings_domain_not_authoritative');
  if(saved.saved)return {owned:true,result:{value:next,changed:true}};
  // A refused batch whose document did not move was refused by an operation-history assertion: retrying cannot help, the caller replans (only for a caller that passed such assertions).
  if(saved.refused&&Array.isArray(env?.admissionGuards)&&env.admissionGuards.length){
   const after=await readParts(gate.db,key);
   if((after.etag??null)===(current.etag??null))throw failed('ratings_domain_fence');
  }
 }
 throw failed('write_contention');
}

function projectionRow(record){
 const row={fact_key:record.factKey,watched:null,actual_rating:null,watchlist:null,rating_known:0,present:{watched:false,rating:false,watchlist:false}};
 if(record.watched){row.watched=record.watched.value===true?1:0;row.present.watched=true;}
 if(record.watchlist){row.watchlist=record.watchlist.value===true?1:0;row.present.watchlist=true;}
 if(record.rating){row.rating_known=1;row.actual_rating=record.rating.value??null;row.present.rating=true;}
 return row;
}
function projectionIds(links={}){
 return [...(links.letterboxd?[String(links.letterboxd)]:[]),...(links.tmdb?['tmdb_'+links.tmdb]:[])];
}

async function viewWrites(db,records){
 const list=(records||[]).filter(record=>record&&record.factKey&&record.links);
 if(!list.length)return [];
 const wanted=new Map();
 for(const record of list){
  const row=projectionRow(record);
  for(const id of projectionIds(record.links))wanted.set(id,{...row,alias_id:id});
 }
 if(!wanted.size)return [];
 if(wanted.size>200)throw failed('ratings_domain_unavailable');
 const ids=[...wanted.keys()];
 const existing=new Map((await many(db,'SELECT alias_id, fact_key, watched, actual_rating, watchlist, rating_known FROM ratings_view WHERE alias_id IN ('+ids.map(()=>'?').join(',')+')',ids)).map(row=>[row.alias_id,row]));
 const now=new Date().toISOString();
 const statements=[];
 for(const [id,row] of wanted){
  const prior=existing.get(id);
  const watched=row.present.watched?row.watched:(prior?prior.watched:null);
  const watchlist=row.present.watchlist?row.watchlist:(prior?prior.watchlist:null);
  const ratingKnown=row.present.rating?1:(prior?Number(prior.rating_known):0);
  const actual=row.present.rating?row.actual_rating:(prior?prior.actual_rating:null);
  if(prior&&prior.fact_key===row.fact_key&&(prior.watched??null)===(watched??null)&&(prior.watchlist??null)===(watchlist??null)&&Number(prior.rating_known)===ratingKnown&&(prior.actual_rating??null)===(actual??null))continue;
  statements.push(['INSERT INTO ratings_view (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(alias_id) DO UPDATE SET fact_key=excluded.fact_key, watched=excluded.watched, actual_rating=excluded.actual_rating, watchlist=excluded.watchlist, rating_known=excluded.rating_known, updated_at=excluded.updated_at',[id,row.fact_key,watched,actual,watchlist,ratingKnown,now]]);
 }
 return statements;
}

export async function projectView(env,records){
 const gate=await requireOpen(env,'d1');
 if(!gate.open)return {owned:false,changed:0};
 const statements=await viewWrites(gate.db,records);
 if(!statements.length)return {owned:true,changed:0};
 const batch=[["UPDATE ratings_domain_authority SET generation=generation WHERE id=1 AND mode='d1' AND cutover='open'",[]],[FENCE_SQL,[]],...epochFence(env),...statements,["UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1 AND mode='d1' AND cutover='open'",[]]];
 await fenced(gate.db,batch);
 return {owned:true,changed:statements.length};
}

async function overlayViewRows(db){
 const rows=[];let after='',total=0;
 for(;;){
  const page=await many(db,'SELECT alias_id, watched, actual_rating, watchlist, rating_known FROM ratings_view WHERE alias_id>? ORDER BY alias_id LIMIT ?',[after,RATINGS_OVERLAY_PAGE]);
  total+=page.length;
  if(total>RATINGS_OVERLAY_ROWS)throw failed('ratings_domain_unavailable');
  rows.push(...page);
  if(page.length<RATINGS_OVERLAY_PAGE)return rows;
  after=page[page.length-1].alias_id;
 }
}
export async function overlayView(env,index){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 // ADR 0162: a held cutover refuses instead of serving the R2 view index's facts; only the uninstalled local domain keeps them.
 if(authority.tables&&!authority.ready)throw failed('ratings_domain_not_authoritative');
 if(!authority.ready)return index;
 const rows=await overlayViewRows(db);
 const base=index&&typeof index==='object'&&!Array.isArray(index)?index:{};
 const next={};
 for(const [id,item] of Object.entries(base)){
  const copy=item&&typeof item==='object'&&!Array.isArray(item)?{...item}:{};
  delete copy.actualRating;delete copy.watched;delete copy.watchlist;
  next[id]=copy;
 }
 for(const row of rows){
  const item={...(next[row.alias_id]||{})};
  if(row.watched===0||row.watched===1||row.watched==='0'||row.watched==='1')item.watched=Number(row.watched)===1;
  else delete item.watched;
  if(row.watchlist===0||row.watchlist===1||row.watchlist==='0'||row.watchlist==='1')item.watchlist=Number(row.watchlist)===1;
  else delete item.watchlist;
  if(Number(row.rating_known)===1)item.actualRating=row.actual_rating==null?null:Number(row.actual_rating);
  else delete item.actualRating;
  next[row.alias_id]=item;
 }
 return next;
}

// AIR-475 (review of the production acceptance fix): the owner's watched mark and rating of the given ids from D1 `ratings_view`, with no dependence on the R2 view index holding the key. `base` is
// {id: entry} for exactly `ids`; the answer lays the D1 facts over each entry (its own watched, rating and watchlist facts are dropped first: D1 is the only source while the domain is d1 and open),
// is `base` unchanged for the uninstalled local domain, and a refusal for a held cutover or any other marker (ADR 0162). One indexed statement; nothing is written; an id with no D1 row has no rating and no mark.
export async function viewItems(env,ids,base){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(authority.tables&&!authority.ready)throw failed('ratings_domain_not_authoritative');
 if(!authority.ready)return base;
 const list=[...new Set(ids)].filter(id=>typeof id==='string'&&id);
 if(!list.length)return base;
 let rows;
 try{rows=await many(db,'SELECT alias_id, watched, actual_rating, watchlist, rating_known FROM ratings_view WHERE alias_id IN ('+list.map(()=>'?').join(',')+')',list);}
 catch(error){throw failed('ratings_domain_unavailable',error);}
 const next={...(base||{})};
 for(const id of list){const copy=next[id]&&typeof next[id]==='object'&&!Array.isArray(next[id])?{...next[id]}:{};delete copy.actualRating;delete copy.watched;delete copy.watchlist;next[id]=copy;}
 for(const row of rows){
  const item=next[row.alias_id];
  if(row.watched===0||row.watched===1||row.watched==='0'||row.watched==='1')item.watched=Number(row.watched)===1;
  if(row.watchlist===0||row.watchlist===1||row.watchlist==='0'||row.watchlist==='1')item.watchlist=Number(row.watchlist)===1;
  if(Number(row.rating_known)===1)item.actualRating=row.actual_rating==null?null:Number(row.actual_rating);
 }
 return next;
}

// ADR 0222: the archives that have a candidate document, from D1, bounded (one SELECT of keys, no bodies). `truncated` is partial, never a complete listing.
export async function listAdmissionArchives(env,limit){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.tables||!authority.ready)throw failed('ratings_domain_not_authoritative');
 const rows=await many(db,"SELECT key FROM ratings_document WHERE part=0 AND key LIKE 'letterboxd/imports/%/rated-candidates.json' ORDER BY key LIMIT ?",[limit+1]);
 const shas=rows.map(row=>row.key).filter(admissionDocumentKey).map(key=>key.split('/')[2]);
 return {shas:shas.slice(0,limit),truncated:shas.length>limit};
}
export async function listDocuments(env){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.tables)throw failed('ratings_domain_not_ready');
 const open={db,authority};
 const keys=(await many(open.db,'SELECT DISTINCT key FROM ratings_document ORDER BY key')).map(row=>row.key);
 const documents=[];
 for(const key of keys){
  const document=await readParts(open.db,key);
  documents.push({key,text:document.text,etag:document.etag});
 }
 return {generation:open.authority.generation,mode:open.authority.mode,cutover:open.authority.cutover,documents};
}

export function ratingsRunActivity(value,now){
 if(!value)return 'absent';
 return value.state==='running'&&Date.parse(value.lease?.expiresAt)>now?'active':'idle';
}

// Read-only operator diagnostic (the production status command): it also reads the run lease of a held cutover, so an operator can see it.
// It is not a serving path and never falls back to R2 for a domain whose tables exist.
export async function readRatingsRun(env){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.tables||authority.mode!=='d1')return {source:'r2',value:null,generation:authority.generation||0};
 const document=await readParts(db,'letterboxd/ratings/run.json');
 return {source:'d1',value:document.value,generation:authority.generation};
}
