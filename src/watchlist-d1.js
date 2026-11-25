// ADR 0186 (Accepted), AIR-569. The Watchlist as its own D1 authority (schema v31, migrations/0031_watchlist_authority.sql). DORMANT: nothing activates it. The Worker reads it only while the
// marker is `d1`; with the tables absent (schema below 31) or the marker `epg` the published EPG generation serves the membership exactly as before. This module is storage only: it never reads or
// writes R2, never fetches Letterboxd, never decides a Workflow slot and never builds an Event (AIR-570 owns those). The Worker bundle wraps it as `WatchlistD1`; tests load it as an ES module.
//
// Authority (one marker row, watchlist_authority, independent of every other domain):
//  - `legacy` (the EPG generation serves) only when the database proves it is pre-migration: the tables are absent AND schema_contract answers a version below 31. A missing binding, an unreadable
//    schema_contract or version 31 without the tables is `closed`. The one exception is the explicit local stand-in `WATCHLIST_DB_OPTIONAL=standin`, never set in production.
//  - mode epg -> `epg`: the EPG generation serves (writes `held` is the import fence); mode d1 -> `d1`: the snapshot serves and R2 is never read as authority.
//  - any other state with the tables present, or a storage error -> `closed`. Never the EPG generation as a fallback for a `d1` read.
//
// A snapshot is published by stage-verify-switch (ADR 0186 decision 1): the attempt stages its own ordered rows under its own snapshot_id (no version named), reads them back, then ONE batch
// asserts the authority, the optional caller guards (the Workflow's mode epoch, AIR-570), a compare-and-swap of the pointer on (version, revision), re-asserts the staged shape, and inserts the snapshot,
// the change rows, the causal effect rows and the admission ledger rows. A loser of the CAS writes nothing but garbage under its own snapshot_id. An unknown outcome is classified BY snapshot_id.

const FENCE='UPDATE watchlist_cas SET ok=changes() WHERE id=1';
// AIR-599: the first-seen snapshots of the ledger rows that are still open (retention keeps their headers).
const LEDGER_REFS="SELECT first_seen_snapshot_id FROM watchlist_admission_pending WHERE state IN ('pending','terminal')";
const TABLES=['watchlist_authority','watchlist_cas','watchlist_current','watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'];
export const SCHEMA_VERSION=31;
export const EFFECTS=['scan_facts','retention','removal_enqueue'];
// ADR 0203 (AIR-582): the fourth, OPTIONAL causal effect. It exists only for a snapshot promoted while the membership marker (schema 37) says `sync`; below that state every promotion has exactly the three effects above.
export const MEMBERSHIP_EFFECT='membership';
export const ALL_EFFECTS=[...EFFECTS,MEMBERSHIP_EFFECT];
export const LIMITS={inChunk:90,stageBatch:50,maxFilms:5000,keepSnapshots:8,stagingGuardMs:30*60000,gcBatch:200,pendingCap:500,staleMs:24*3600000,textChars:500,pruneBatch:200};
// The marker read also proves the singleton fence row exists: without it the domain is closed.
const MARKER_SQL='SELECT mode, generation, writes, (SELECT COUNT(*) FROM watchlist_cas WHERE id=1) AS cas FROM watchlist_authority WHERE id=1';
const CURRENT_SQL='SELECT version, snapshot_id, list_sha256, film_count, last_success_at, last_success_run, last_success_slot, last_attempt_at, last_attempt_outcome, effects_drained_version, mirror_delivered_snapshot_id, mirror_attempts, mirror_next_retry_at, revision FROM watchlist_current WHERE id=1';
// Every guard of a batch is an upsert of the fence row, never an UPDATE of it: an UPDATE that matches no row passes silently, while the upsert evaluates `CHECK (ok = 1)` on both paths.
const GUARD=expression=>'INSERT INTO watchlist_cas (id, ok) SELECT 1, '+expression+' WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const AUTHORITY_GUARD=[GUARD("(SELECT COUNT(*) FROM watchlist_authority WHERE id=1 AND mode='d1' AND writes='open' AND generation=?)"),null];

function database(source){return source&&typeof source.prepare==='function'?source:source?.DB;}
export function bindingOf(source){const db=database(source);return db&&typeof db.prepare==='function'?db:null;}
async function one(db,sql,params=[]){return (await db.prepare(sql).bind(...params).first())??null;}
async function many(db,sql,params=[]){return (await db.prepare(sql).bind(...params).all()).results||[];}
async function sha256(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
const iso=ms=>new Date(ms).toISOString();

// -> {state:'legacy'} | {state:'epg'|'d1',writes,generation} | {state:'closed',reason:'unavailable'|'contradiction'}
//    `unavailable` is a storage error (a retryable D1 fault); `contradiction` is a state that cannot be served (structural, never retried into another source).
export async function readAuthority(source){
 const db=database(source);
 const standin=source?.WATCHLIST_DB_OPTIONAL==='standin';
 if(!db||typeof db.prepare!=='function')return standin?{state:'legacy'}:{state:'closed',reason:'contradiction'};
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+')')).map(row=>row.name);}
 catch{return {state:'closed',reason:'unavailable'};}
 if(!names.length){
  let version=null;
  try{version=Number((await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version);}catch{return standin?{state:'legacy'}:{state:'closed',reason:'unavailable'};}
  return Number.isFinite(version)&&version<SCHEMA_VERSION?{state:'legacy'}:(standin?{state:'legacy'}:{state:'closed',reason:'contradiction'});
 }
 if(TABLES.some(name=>!names.includes(name)))return {state:'closed',reason:'contradiction'};
 let row;
 try{row=await one(db,MARKER_SQL);}catch{return {state:'closed',reason:'unavailable'};}
 if(!row||Number(row.cas)!==1||(row.mode!=='epg'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held')||!Number.isInteger(Number(row.generation)))return {state:'closed',reason:'contradiction'};
 return {state:row.mode,writes:row.writes,generation:Number(row.generation)};
}

// ---- the list ------------------------------------------------------------------------------------------------------------
// A scan result film: {id (the Letterboxd id), title, year, url}. The Worker's parsed list uses `id`; the table uses `lid`. -> normalized films or null
export function normalizeFilms(list){
 if(!Array.isArray(list)||list.length>LIMITS.maxFilms)return null;
 const out=[],seen=new Set();
 for(let ordinal=0;ordinal<list.length;ordinal++){
  const film=list[ordinal];
  if(!film||typeof film!=='object')return null;
  const lid=film.lid??film.id;
  if(typeof lid!=='string'||!lid||lid.length>100||seen.has(lid))return null;
  seen.add(lid);
  const title=film.title==null?'':film.title,url=film.url;
  if(typeof title!=='string'||title.length>LIMITS.textChars||typeof url!=='string'||!url||url.length>LIMITS.textChars)return null;
  const year=film.year==null?null:film.year;
  if(year!==null&&!(Number.isInteger(year)&&year>=1800&&year<=2200))return null;
  out.push({ordinal,lid,title,year,url});
 }
 return out;
}
// The digest of an ORDERED list. Equality of lengths is never equality of the list: a 1-for-1 replacement changes it.
export async function listDigest(films){return sha256(films.map(film=>film.ordinal+'\t'+film.lid+'\t'+film.title+'\t'+(film.year??'')+'\t'+film.url+'\n').join(''));}
export function toEpgFilm(film){return {id:film.lid,title:film.title,...(film.year==null?{}:{year:film.year}),url:film.url};}

function membersOk(rows,count){
 if(rows.length!==count)return false;
 const ids=new Set();
 for(let index=0;index<rows.length;index++){
  if(Number(rows[index].ordinal)!==index||typeof rows[index].lid!=='string'||!rows[index].lid||ids.has(rows[index].lid))return false;
  ids.add(rows[index].lid);
 }
 return true;
}
const filmOf=row=>({ordinal:Number(row.ordinal),lid:row.lid,title:row.title,year:row.year==null?null:Number(row.year),url:row.url});
const currentOf=row=>({version:Number(row.version),snapshotId:row.snapshot_id??null,listSha256:row.list_sha256??null,filmCount:row.film_count==null?null:Number(row.film_count),lastSuccessAt:row.last_success_at??null,lastSuccessRun:row.last_success_run??null,lastSuccessSlot:row.last_success_slot??null,lastAttemptAt:row.last_attempt_at??null,lastAttemptOutcome:row.last_attempt_outcome??null,effectsDrainedVersion:Number(row.effects_drained_version),mirrorDeliveredSnapshotId:row.mirror_delivered_snapshot_id??null,mirrorAttempts:Number(row.mirror_attempts),mirrorNextRetryAt:row.mirror_next_retry_at??null,revision:Number(row.revision)});

// The age warning of ADR 0186 decision 6: no hard TTL, a warning above 24 hours.
export function staleness(lastSuccessAt,now=Date.now()){
 const at=Date.parse(lastSuccessAt||'');
 if(!Number.isFinite(at))return {stale:true,ageMs:null};
 const age=Math.max(0,now-at);
 return {stale:age>LIMITS.staleMs,ageMs:age};
}

// The current snapshot, assembled and verified, in ONE read batch (marker, pointer, snapshot row, members), so they are one view.
// -> {ok:true,snapshot} | {ok:false,reason:'closed'|'held'|'moved'|'absent'|'malformed'|'unavailable'}
//    snapshot = {version,snapshotId,observedAt,committedAt,lastSuccessAt,listSha256,filmCount,films:[{ordinal,lid,title,year,url}],stale,ageMs,current}
// `closed`: the marker is not `d1` (this reader never answers for another mode). `held`: writes are held (an import fence): refused, never served. `moved`: `generation` was given and the marker
// carries another one (the authority changed between the caller's check and this read). `absent`: version 0, nothing was ever promoted or imported.
export async function readCurrent(source,{now=Date.now(),generation=null}={}){
 const db=database(source);
 if(!db||typeof db.batch!=='function')return {ok:false,reason:'unavailable'};
 let parts;
 try{
  parts=await db.batch([
   MARKER_SQL,CURRENT_SQL,
   'SELECT snapshot_id, version, scan_id, observed_at, committed_at, film_count, list_sha256, prev_version, slot_key, run_id FROM watchlist_snapshot WHERE snapshot_id=(SELECT snapshot_id FROM watchlist_current WHERE id=1)',
   'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=(SELECT snapshot_id FROM watchlist_current WHERE id=1) ORDER BY ordinal',
  ].map(sql=>db.prepare(sql).bind()));
 }catch{return {ok:false,reason:'unavailable'};}
 const [marker,current,snapshot,members]=parts.map(part=>part.results||[]);
 if(!marker[0]||marker[0].mode!=='d1'||Number(marker[0].cas)!==1)return {ok:false,reason:'closed'};
 if(marker[0].writes!=='open')return {ok:false,reason:'held'};
 if(generation!==null&&Number(marker[0].generation)!==generation)return {ok:false,reason:'moved'};
 if(!current[0])return {ok:false,reason:'malformed'};
 const pointer=currentOf(current[0]);
 if(pointer.version===0||!pointer.snapshotId)return {ok:false,reason:'absent'};
 try{
  const row=snapshot[0];
  // The bootstrap import (version 1) is a snapshot too: it has a row in watchlist_snapshot with its own digest.
  if(!row||Number(row.version)!==pointer.version||row.list_sha256!==pointer.listSha256||Number(row.film_count)!==pointer.filmCount)return {ok:false,reason:'malformed'};
  if(!membersOk(members,pointer.filmCount))return {ok:false,reason:'malformed'};
  const films=members.map(filmOf);
  if(await listDigest(films)!==pointer.listSha256)return {ok:false,reason:'malformed'};
  const age=staleness(pointer.lastSuccessAt,now);
  return {ok:true,snapshot:{version:pointer.version,snapshotId:pointer.snapshotId,observedAt:row.observed_at,committedAt:row.committed_at,lastSuccessAt:pointer.lastSuccessAt,listSha256:pointer.listSha256,filmCount:pointer.filmCount,films,stale:age.stale,ageMs:age.ageMs,current:pointer,authority:{generation:Number(marker[0].generation),writes:'open'}}};
 }catch{return {ok:false,reason:'malformed'};}
}

// The one read of the EPG run start (ADR 0186 decision 6): the ordered list to copy into the run and the three pin fields. It never waits, never calls Letterboxd and has no TTL.
// Fail-closed only when no snapshot exists or it is unreadable (a D1 fault, not a Letterboxd one). -> {ok:true,films,pin,warning} | {ok:false,reason}
export async function pinForEpg(source,{now=Date.now(),generation=null}={}){
 const out=await readCurrent(source,{now,generation});
 if(!out.ok)return {ok:false,reason:out.reason==='absent'?'watchlist_snapshot_absent':out.reason==='held'?'watchlist_writes_held':out.reason==='moved'?'watchlist_authority_moved':'watchlist_unavailable'};
 const s=out.snapshot;
 return {ok:true,films:s.films.map(toEpgFilm),pin:{watchlistVersion:s.version,watchlistSnapshotId:s.snapshotId,watchlistLastSuccessAt:s.lastSuccessAt,watchlistObservedAt:s.observedAt,watchlistListSha256:s.listSha256},warning:s.stale?'watchlist_stale':null,ageMs:s.ageMs};
}

// The added and removed ids of one promoted snapshot, from the durable change rows. -> {ok:true,added:[{lid,ordinal}],removed:[{lid,prevOrdinal}]} | {ok:false,reason}
export async function readChanges(source,snapshotId){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 let rows;
 try{rows=await many(db,'SELECT kind, lid, ordinal, prev_ordinal FROM watchlist_change WHERE snapshot_id=? ORDER BY kind, COALESCE(ordinal, prev_ordinal)',[snapshotId]);}catch{return {ok:false,reason:'unavailable'};}
 return {ok:true,added:rows.filter(row=>row.kind==='added').map(row=>({lid:row.lid,ordinal:Number(row.ordinal)})),removed:rows.filter(row=>row.kind==='removed').map(row=>({lid:row.lid,prevOrdinal:Number(row.prev_ordinal)}))};
}

// The ordered members and header of ONE promoted snapshot (not only the current one): the causal effects of an older version are applied after a newer one was promoted, so they need their own list.
// Read only. -> {ok:true,snapshot:{snapshotId,version,scanId,observedAt,committedAt,slotKey,runId,films}} | {ok:false,reason:'absent'|'malformed'|'unavailable'}
export async function readSnapshot(source,snapshotId){
 const db=database(source);
 if(!db||typeof snapshotId!=='string'||!snapshotId)return {ok:false,reason:'unavailable'};
 let head,rows;
 try{
  head=await one(db,'SELECT snapshot_id, version, scan_id, observed_at, committed_at, film_count, list_sha256, prev_version, slot_key, run_id FROM watchlist_snapshot WHERE snapshot_id=?',[snapshotId]);
  if(!head)return {ok:false,reason:'absent'};
  rows=await many(db,'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[snapshotId]);
 }catch{return {ok:false,reason:'unavailable'};}
 if(!membersOk(rows,Number(head.film_count)))return {ok:false,reason:'malformed'};
 const films=rows.map(filmOf);
 if(await listDigest(films)!==head.list_sha256)return {ok:false,reason:'malformed'};
 return {ok:true,snapshot:{snapshotId:head.snapshot_id,version:Number(head.version),scanId:head.scan_id,observedAt:head.observed_at,committedAt:head.committed_at,prevVersion:Number(head.prev_version),slotKey:head.slot_key,runId:head.run_id,films}};
}
// The id of the promoted snapshot of one version (the predecessor named by `prevVersion`). -> {ok:true,snapshotId} | {ok:false,reason:'absent'|'unavailable'}
export async function snapshotIdOfVersion(source,version){
 const db=database(source);
 if(!db||!Number.isInteger(version)||version<1)return {ok:false,reason:'absent'};
 try{const row=await one(db,'SELECT snapshot_id FROM watchlist_snapshot WHERE version=?',[version]);return row?{ok:true,snapshotId:row.snapshot_id}:{ok:false,reason:'absent'};}catch{return {ok:false,reason:'unavailable'};}
}

// ---- the fenced batch ----------------------------------------------------------------------------------------------------
// `extra` = the caller's own guards, [sql, params] pairs that INSERT into watchlist_cas through GUARD (the Workflow mode epoch of AIR-570). Statements with more than 100 binds are refused.
async function fenced(db,statements){
 if(typeof db.batch!=='function')return 'unavailable';
 if(statements.some(([,params])=>params.length>100))return 'unavailable';
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return 'ok';}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY|watchlist_current_regress|PRIMARY KEY/i.test(message))return 'conflict';
  return 'unavailable';
 }
}
export const guardOf=GUARD;
const authorityGuard=generation=>[AUTHORITY_GUARD[0],[generation]];
function callerGuards(ctx){
 if(ctx?.guards===undefined||ctx.guards===null)return [];
 const extra=ctx.guards;
 if(!Array.isArray(extra))return null;
 return extra.every(item=>Array.isArray(item)&&typeof item[0]==='string'&&Array.isArray(item[1]))?extra:null;
}

// What an unknown publish was, from the snapshot id and never from the pointer alone (ADR 0186 decision 1, T13).
// -> 'applied' | 'not_applied' | 'superseded' | 'indeterminate'
export async function classifyPublish(source,{snapshotId,expectedVersion}){
 const db=database(source);
 if(!db||typeof snapshotId!=='string'||!Number.isInteger(expectedVersion)||expectedVersion<0)return 'indeterminate';
 try{
  const promoted=await one(db,'SELECT version FROM watchlist_snapshot WHERE snapshot_id=?',[snapshotId]);
  if(promoted)return 'applied';
  const row=await one(db,'SELECT version, snapshot_id FROM watchlist_current WHERE id=1');
  if(!row)return 'indeterminate';
  if(Number(row.version)===expectedVersion)return 'not_applied';
  if(Number(row.version)>expectedVersion&&row.snapshot_id&&row.snapshot_id!==snapshotId)return 'superseded';
  return 'indeterminate';
 }catch{return 'indeterminate';}
}

// Removes at most `gcBatch` member rows (and then the staging rows) of abandoned attempts per call: attempts that are neither the current pointer, nor a promoted snapshot, nor newer than the
// 30-minute guard. Each pass is fenced. -> {ok:true,removed} | {ok:false,reason}
export async function cleanupAbandoned(source,ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const cutoff=iso((ctx.now??Date.now())-LIMITS.stagingGuardMs);
 const abandoned="snapshot_id IN (SELECT snapshot_id FROM watchlist_staging WHERE started_at<? AND snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_snapshot) AND snapshot_id IS NOT (SELECT snapshot_id FROM watchlist_current WHERE id=1))";
 let removed=0;
 for(let pass=0;pass<5;pass++){
  let before;
  try{before=Number((await one(db,'SELECT COUNT(*) AS n FROM watchlist_member WHERE '+abandoned,[cutoff]))?.n);}catch{return {ok:false,reason:'unavailable'};}
  if(!before)break;
  const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,['DELETE FROM watchlist_member WHERE rowid IN (SELECT rowid FROM watchlist_member WHERE '+abandoned+' LIMIT ?)',[cutoff,LIMITS.gcBatch]]]);
  if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
  removed+=Math.min(before,LIMITS.gcBatch);
 }
 // Staging rows with no member left (and no promotion) go with their members.
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,['DELETE FROM watchlist_staging WHERE started_at<? AND snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_snapshot) AND snapshot_id IS NOT (SELECT snapshot_id FROM watchlist_current WHERE id=1) AND snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_member)',[cutoff]]]);
 if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
 return {ok:true,removed};
}

// A failed or incomplete scan updates only the attempt columns, ordered by attempt time, never the success columns (ADR 0186 decision 1). Guarded by the authority only.
// -> {ok:true} | {ok:false,reason}
export async function recordAttempt(source,{at,outcome,now,guards}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||typeof outcome!=='string'||!outcome||outcome.length>60)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const extra=callerGuards({guards});
 if(!extra)return {ok:false,reason:'shape'};
 const result=await fenced(db,[authorityGuard(gate.generation),...extra,
  ['UPDATE watchlist_current SET last_attempt_at=?, last_attempt_outcome=?, revision=revision+1, updated_at=? WHERE id=1 AND (last_attempt_at IS NULL OR last_attempt_at<=?)',[at,outcome,iso(now??Date.now()),at]]]);
 if(result==='conflict')return {ok:false,reason:'conflict'};
 return result==='ok'?{ok:true}:{ok:false,reason:'unavailable'};
}

// ---- mirror delivery bookkeeping (AIR-571 M1, ADR 0186 decision 1a) --------------------------------------------------------------
// `mirror_delivered_snapshot_id` holds the DELIVERY TOKEN `<snapshot_id>|<last_success_at>` of the last root `watchlist.json` the mirror reconcile proved stored: a no_change scan moves `last_success_at` without a new
// snapshot id, and the root carries that freshness, so the token is what is owed, not the snapshot id alone. The debt is always ONE target, the current pointer. These writes raise `revision` by one like every write of the pointer (the table's trigger requires it); they happen only while the target is still owed, so a repeated acknowledgement changes nothing. A scan whose pointer compare-and-swap loses to one is replayed by the
// repository adapter only when the pointer proves bookkeeping-only contention (see pointerPin). They carry the authority guard, so they only land while the marker is `d1`/`open` at the generation the reconcile read.
export const mirrorToken=(snapshotId,lastSuccessAt)=>String(snapshotId)+'|'+String(lastSuccessAt);
// outcome 'delivered' (proved stored) | 'failed' (attempts+1 and the next retry time, compare-and-swap on the attempts read). -> {ok:true} | {ok:false,reason:'closed'|'writes_held'|'moved'|'conflict'|'shape'|'unavailable'}
export async function recordMirror(source,{outcome,snapshotId,lastSuccessAt,generation,attempts=0,nextRetryAt=null,now,guards}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!['delivered','failed'].includes(outcome)||typeof snapshotId!=='string'||!snapshotId||typeof lastSuccessAt!=='string'||!Number.isInteger(generation)||!Number.isInteger(attempts)||attempts<0)return {ok:false,reason:'shape'};
 if(outcome==='failed'&&!(typeof nextRetryAt==='string'&&Number.isFinite(Date.parse(nextRetryAt))))return {ok:false,reason:'shape'};
 const extra=callerGuards({guards});
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 if(gate.generation!==generation)return {ok:false,reason:'moved'};
 const at=iso(now??Date.now());
 const token=mirrorToken(snapshotId,lastSuccessAt);
 // Diagnostics: an already delivered target is reported as such (`applied:false`), never as a newly recorded attempt or acknowledgement. The batch below still re-asserts everything.
 let seen=null;
 try{seen=await one(db,'SELECT snapshot_id, last_success_at, mirror_delivered_snapshot_id FROM watchlist_current WHERE id=1');}catch{return {ok:false,reason:'unavailable'};}
 if(seen&&seen.snapshot_id===snapshotId&&seen.last_success_at===lastSuccessAt&&seen.mirror_delivered_snapshot_id===token)return {ok:true,applied:false,reason:'already_delivered'};
 // The target must still be the CURRENT pointer (a guard, so a stale pass records nothing), and the bookkeeping applies only while the target is still OWED: an already delivered target is an idempotent no-op
 // (no row change, so no revision bump and no contention with a scan), and a late failure never records debt after a successful acknowledgement of the same target.
 const targetGuard=[GUARD('(SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND snapshot_id=? AND last_success_at=?)'),[snapshotId,lastSuccessAt]];
 const update=outcome==='delivered'
  ?['UPDATE watchlist_current SET mirror_delivered_snapshot_id=?, mirror_attempts=0, mirror_next_retry_at=NULL, revision=revision+1, updated_at=? WHERE id=1 AND snapshot_id=? AND last_success_at=? AND mirror_delivered_snapshot_id IS NOT ?',[token,at,snapshotId,lastSuccessAt,token]]
  :['UPDATE watchlist_current SET mirror_attempts=mirror_attempts+1, mirror_next_retry_at=?, revision=revision+1, updated_at=? WHERE id=1 AND snapshot_id=? AND last_success_at=? AND mirror_attempts=? AND mirror_delivered_snapshot_id IS NOT ?',[nextRetryAt,at,snapshotId,lastSuccessAt,attempts,token]];
 // `applied` comes from the ACTUAL result of the conditional UPDATE: a trailing `SELECT changes()` in the same batch answers with the affected rows of that very statement. The early read above proves nothing about
 // the batch (another pass may have acknowledged, or won the attempts compare-and-swap, in between): a batch that succeeded but changed no row is a proven no-op (`applied:false`), and a result that cannot be read
 // is unproven (`applied:null`), never reported as recorded.
 const statements=[authorityGuard(generation),...extra,targetGuard,update,['SELECT changes() AS changed',[]]];
 if(statements.some(([,params])=>params.length>100))return {ok:false,reason:'unavailable'};
 let results;
 try{results=await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY|watchlist_current_regress|PRIMARY KEY/i.test(message))return {ok:false,reason:'conflict'};
  return {ok:false,reason:'unavailable'};
 }
 // Only an explicit numeric 0 or 1 is a result: null, a string or anything else is unproven (never coerced to 0).
 const changed=results?.[results.length-1]?.results?.[0]?.changed;
 if(typeof changed!=='number'||(changed!==0&&changed!==1))return {ok:true,applied:null,reason:'result_unreadable'};
 return changed>0?{ok:true,applied:true}:{ok:true,applied:false,reason:'not_owed'};
}

// The exact pointer a scan started from, and the guard that re-asserts it in the batch of a replay (AIR-571 M1 review): {version, snapshotId, lastSuccessAt, revision, generation} | null.
export async function pointerPin(source){
 const db=database(source);
 if(!db)return null;
 try{
  // ONE read of the pointer and the authority: they are the same instant, never two reads that could straddle a transition.
  const row=await one(db,"SELECT c.version AS version, c.snapshot_id AS snapshot_id, c.last_success_at AS last_success_at, c.revision AS revision, a.mode AS mode, a.writes AS writes, a.generation AS generation, (SELECT COUNT(*) FROM watchlist_cas WHERE id=1) AS cas FROM watchlist_current c, watchlist_authority a WHERE c.id=1 AND a.id=1");
  if(!row||row.mode!=='d1'||row.writes!=='open'||Number(row.cas)!==1)return null;
  return {version:Number(row.version),snapshotId:row.snapshot_id??null,lastSuccessAt:row.last_success_at??null,revision:Number(row.revision),generation:Number(row.generation)};
 }catch{return null;}
}
// The guard of a replay: the pointer is still the one the scan started from AND the authority is still the same open generation (so a replay can never commit across a marker transition).
export const pointerGuard=pin=>[GUARD("CASE WHEN (SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND version=? AND snapshot_id IS ? AND last_success_at IS ?)=1 AND (SELECT COUNT(*) FROM watchlist_authority WHERE id=1 AND mode='d1' AND writes='open' AND generation=?)=1 THEN 1 ELSE 0 END"),[pin.version,pin.snapshotId,pin.lastSuccessAt,pin.generation]];

// ---- publication ---------------------------------------------------------------------------------------------------------
// ADR 0186 decision 1: a complete scan result becomes the new snapshot, or a no-op. The caller proves completeness (every page, total, repeat read of page 1); this function never decides it.
// `scan` = {scanId, observedAt, runId?, slotKey?, completedAt?}; `ctx` = {now?, guards?, attemptId?, snapshotId?}. `films` = the ordered list of the scan.
// -> {ok:true,outcome:'committed',version,snapshotId,added,removed} | {ok:true,outcome:'no_change',version}
//  | {ok:false,reason:'closed'|'writes_held'|'shape'|'effects_pending'|'conflict'|'indeterminate'|'unavailable'|'admission_ledger_full'|'malformed'}
export async function publishSnapshot(source,films,scan,ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const normalized=normalizeFilms(films);
 if(!normalized||!scan||typeof scan.scanId!=='string'||!scan.scanId||scan.scanId.length>100||typeof scan.observedAt!=='string'||!Number.isFinite(Date.parse(scan.observedAt)))return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const now=ctx.now??Date.now(),stamp=iso(now);
 const digest=await listDigest(normalized);
 let current;
 try{current=await one(db,CURRENT_SQL);}catch{return {ok:false,reason:'unavailable'};}
 if(!current)return {ok:false,reason:'malformed'};
 const pointer=currentOf(current);
 // The same ORDERED list: no snapshot, member, change or effect rows. It first requires the causal effects of every promoted version to be drained, then advances last_success_at only.
 if(pointer.version>0&&pointer.listSha256===digest&&pointer.filmCount===normalized.length){
  if(pointer.effectsDrainedVersion<pointer.version)return {ok:false,reason:'effects_pending'};
  const completed=typeof scan.completedAt==='string'&&Number.isFinite(Date.parse(scan.completedAt))?scan.completedAt:stamp;
  const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
   [GUARD('(SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND version=? AND revision=? AND effects_drained_version=version)'),[pointer.version,pointer.revision]],
   ['UPDATE watchlist_current SET last_success_at=CASE WHEN last_success_at IS NULL OR last_success_at<? THEN ? ELSE last_success_at END, last_success_run=?, last_success_slot=?, last_attempt_at=?, last_attempt_outcome=\'no_change\', revision=revision+1, updated_at=? WHERE id=1 AND version=? AND revision=?',[completed,completed,scan.runId??null,scan.slotKey??null,completed,stamp,pointer.version,pointer.revision]],
   [FENCE,[]]]);
  if(outcome==='ok')return {ok:true,outcome:'no_change',version:pointer.version};
  return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
 }
 // Admission ledger cap (ADR 0186 decision 5): refuse loudly, never drop an id.
 let previousRows=[];
 if(pointer.snapshotId){try{previousRows=await many(db,'SELECT ordinal, lid FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[pointer.snapshotId]);}catch{return {ok:false,reason:'unavailable'};}}
 const before=new Map(previousRows.map(row=>[row.lid,Number(row.ordinal)])),after=new Map(normalized.map(film=>[film.lid,film.ordinal]));
 const added=normalized.filter(film=>!before.has(film.lid)).map(film=>({lid:film.lid,ordinal:film.ordinal}));
 const removed=previousRows.filter(row=>!after.has(row.lid)).map(row=>({lid:row.lid,prevOrdinal:Number(row.ordinal)}));
 if(pointer.version>0&&!membersOk(previousRows,pointer.filmCount))return {ok:false,reason:'malformed'};
 let pendingNow;
 try{pendingNow=Number((await one(db,"SELECT COUNT(*) AS n FROM watchlist_admission_pending WHERE state='pending'"))?.n);}catch{return {ok:false,reason:'unavailable'};}
 // Only ids that do not already have a row add to the ledger; a returning id continues its own row.
 let fresh=0;
 if(added.length){
  // D1 allows 100 bound parameters per statement: the read is chunked (a promotion that adds more than 99 ids in one scan would otherwise fail on a real D1 with "too many SQL variables", found by the AIR-571 resource QA).
  const existing=new Set();
  try{for(let from=0;from<added.length;from+=LIMITS.inChunk){const chunk=added.slice(from,from+LIMITS.inChunk);for(const row of await many(db,'SELECT lid FROM watchlist_admission_pending WHERE lid IN ('+chunk.map(()=>'?').join(',')+')',chunk.map(item=>item.lid)))existing.add(row.lid);}}catch{return {ok:false,reason:'unavailable'};}
  fresh=added.filter(item=>!existing.has(item.lid)).length;
 }
 if(pendingNow+fresh>LIMITS.pendingCap)return {ok:false,reason:'admission_ledger_full'};

 const snapshotId=ctx.snapshotId??crypto.randomUUID(),attemptId=ctx.attemptId??snapshotId;
 const swept=await cleanupAbandoned(db,{now,guards:extra});
 if(!swept.ok)return swept;
 const stage=await fenced(db,[authorityGuard(gate.generation),...extra,['INSERT INTO watchlist_staging (snapshot_id, attempt_id, run_id, slot_key, expected_count, expected_sha256, started_at) VALUES (?,?,?,?,?,?,?)',[snapshotId,attemptId,scan.runId??null,scan.slotKey??null,normalized.length,digest,stamp]]]);
 if(stage!=='ok')return {ok:false,reason:stage==='conflict'?'conflict':'unavailable'};
 for(let at=0;at<normalized.length;at+=LIMITS.stageBatch){
  const slice=normalized.slice(at,at+LIMITS.stageBatch);
  const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,...slice.map(film=>['INSERT INTO watchlist_member (snapshot_id, ordinal, lid, title, year, url) VALUES (?,?,?,?,?,?)',[snapshotId,film.ordinal,film.lid,film.title,film.year,film.url]])]);
  if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
 }
 let staged;
 try{staged=await many(db,'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[snapshotId]);}catch{return {ok:false,reason:'unavailable'};}
 if(!membersOk(staged,normalized.length)||await listDigest(staged.map(filmOf))!==digest)return {ok:false,reason:'malformed'};

 const count=normalized.length,version=pointer.version+1;
 // ADR 0203: the effect set of this promotion is decided by the membership marker READ NOW and re-asserted INSIDE the promotion batch, so a switch that lands between this read and the commit aborts the batch whole
 // (a promotion can never carry the old effect set after the switch, nor the new one before it). An absent marker table (schema below 37) is the legacy three effects with no extra statement.
 const marker=await readMembershipAuthority(db);
 if(!marker.ok)return {ok:false,reason:'unavailable'};
 const effectsFor=marker.present&&marker.mode==='sync'?ALL_EFFECTS:EFFECTS;
 const markerGuard=marker.present?[[GUARD("(SELECT COUNT(*) FROM watchlist_membership_authority WHERE id=1 AND mode=? AND generation=?)"),[marker.mode,marker.generation]]]:[];
 const statements=[
  authorityGuard(gate.generation),
  ...extra,
  ...markerGuard,
  // The pointer: compare-and-swap on (version, revision). This is where the next version number is assigned.
  ['UPDATE watchlist_current SET version=?, snapshot_id=?, list_sha256=?, film_count=?, last_success_at=CASE WHEN last_success_at IS NULL OR last_success_at<? THEN ? ELSE last_success_at END, last_success_run=?, last_success_slot=?, last_attempt_at=?, last_attempt_outcome=\'committed\', revision=revision+1, updated_at=? WHERE id=1 AND version=? AND revision=?',[version,snapshotId,digest,count,scan.completedAt??stamp,scan.completedAt??stamp,scan.runId??null,scan.slotKey??null,scan.completedAt??stamp,stamp,pointer.version,pointer.revision]],
  [FENCE,[]],
  // The attempt's own staged rows must still be the whole list.
  [GUARD('CASE WHEN (SELECT COUNT(*) FROM watchlist_member WHERE snapshot_id=?)=? AND (SELECT COALESCE(MIN(ordinal),0) FROM watchlist_member WHERE snapshot_id=?)=0 AND (SELECT COALESCE(MAX(ordinal),-1) FROM watchlist_member WHERE snapshot_id=?)=?-1 AND (SELECT COUNT(DISTINCT lid) FROM watchlist_member WHERE snapshot_id=?)=? THEN 1 ELSE 0 END'),[snapshotId,count,snapshotId,snapshotId,count,snapshotId,count]],
  ['INSERT INTO watchlist_snapshot (snapshot_id, version, scan_id, observed_at, committed_at, film_count, list_sha256, prev_version, slot_key, run_id) VALUES (?,?,?,?,?,?,?,?,?,?)',[snapshotId,version,scan.scanId,scan.observedAt,stamp,count,digest,pointer.version,scan.slotKey??null,scan.runId??null]],
  ...added.map(item=>['INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) VALUES (?,\'added\',?,?,NULL)',[snapshotId,item.lid,item.ordinal]]),
  ...removed.map(item=>['INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) VALUES (?,\'removed\',?,NULL,?)',[snapshotId,item.lid,item.prevOrdinal]]),
  ...effectsFor.map(effect=>['INSERT INTO watchlist_effect (snapshot_id, effect, status, receipt, attempts, done_at) VALUES (?,?,\'pending\',NULL,0,NULL)',[snapshotId,effect]]),
  // A new id enters the ledger once; a returning id continues its row as pending (a superseded or resolved row is re-opened by the new addition).
  ...added.map(item=>['INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES (?,?,?,\'pending\',0,NULL,NULL,NULL,?) ON CONFLICT(lid) DO UPDATE SET state=\'pending\', first_seen_snapshot_id=excluded.first_seen_snapshot_id, first_seen_version=excluded.first_seen_version, attempts=0, next_retry_at=NULL, last_reason=NULL, resolved_by=NULL, updated_at=excluded.updated_at WHERE state IN (\'superseded\')',[item.lid,snapshotId,version,stamp]]),
 ];
 if(statements.some(([,params])=>params.length>100))return {ok:false,reason:'unavailable'};
 const outcome=await fenced(db,statements);
 const done=()=>({ok:true,outcome:'committed',version,snapshotId,added:added.map(item=>item.lid),removed:removed.map(item=>item.lid)});
 if(outcome==='ok')return done();
 const kind=await classifyPublish(db,{snapshotId,expectedVersion:pointer.version});
 if(kind==='applied')return done();
 if(kind==='indeterminate')return {ok:false,reason:'indeterminate',snapshotId};
 return {ok:false,reason:outcome==='conflict'||kind==='superseded'?'conflict':'unavailable',snapshotId};
}

// ---- the causal effects journal -------------------------------------------------------------------------------------------
// The pending causal effects of every promoted snapshot, oldest version first, `limit` rows. Delivery (mirror, Events) is not here. -> {ok:true,effects:[{snapshotId,version,effect,attempts}]} | {ok:false,reason}
export async function pendingEffects(source,{limit=ALL_EFFECTS.length*4}={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 let rows;
 try{rows=await many(db,"SELECT e.snapshot_id AS snapshotId, s.version AS version, e.effect AS effect, e.attempts AS attempts, e.receipt AS progress FROM watchlist_effect e JOIN watchlist_snapshot s ON s.snapshot_id=e.snapshot_id WHERE e.status='pending' ORDER BY s.version, CASE e.effect WHEN 'scan_facts' THEN 1 WHEN 'retention' THEN 2 WHEN 'removal_enqueue' THEN 3 ELSE 4 END LIMIT ?",[Math.max(1,Math.min(200,limit))]);}
 catch{return {ok:false,reason:'unavailable'};}
 return {ok:true,effects:rows.map(row=>({snapshotId:row.snapshotId,version:Number(row.version),effect:row.effect,attempts:Number(row.attempts),progress:typeof row.progress==='string'&&row.progress?row.progress:null}))};
}
// Marks one effect done with the writer's receipt. Strictly in version order: refused when a lower version still has a pending effect, and, inside a version, when an earlier effect
// (scan_facts, then retention, then removal_enqueue) is pending. `effects_drained_version` advances in the same batch that marks the last effect of a version done.
// -> {ok:true,drained:boolean} | {ok:false,reason:'closed'|'writes_held'|'shape'|'out_of_order'|'unavailable'|'conflict'}
export async function completeEffect(source,{snapshotId,effect,receipt},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(typeof snapshotId!=='string'||!ALL_EFFECTS.includes(effect)||typeof receipt!=='string'||!receipt||receipt.length>200)return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 let snapshot;
 try{snapshot=await one(db,'SELECT version FROM watchlist_snapshot WHERE snapshot_id=?',[snapshotId]);}catch{return {ok:false,reason:'unavailable'};}
 if(!snapshot)return {ok:false,reason:'shape'};
 const version=Number(snapshot.version),order=ALL_EFFECTS.indexOf(effect),earlier=ALL_EFFECTS.slice(0,order);
 const stamp=iso(ctx.now??Date.now());
 const lowerPending='(SELECT COUNT(*) FROM watchlist_effect e JOIN watchlist_snapshot s ON s.snapshot_id=e.snapshot_id WHERE e.status=\'pending\' AND s.version<?)';
 const earlierPending=earlier.length?'(SELECT COUNT(*) FROM watchlist_effect WHERE snapshot_id=? AND status=\'pending\' AND effect IN ('+earlier.map(()=>'?').join(',')+'))':'0';
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  [GUARD('CASE WHEN '+lowerPending+'=0 AND '+earlierPending+'=0 THEN 1 ELSE 0 END'),[version,...(earlier.length?[snapshotId,...earlier]:[])]],
  ['UPDATE watchlist_effect SET status=\'done\', receipt=?, attempts=attempts+1, done_at=? WHERE snapshot_id=? AND effect=? AND status=\'pending\'',[receipt,stamp,snapshotId,effect]],
  [FENCE,[]],
  ['UPDATE watchlist_current SET effects_drained_version=?, revision=revision+1, updated_at=? WHERE id=1 AND effects_drained_version<? AND (SELECT COUNT(*) FROM watchlist_effect e JOIN watchlist_snapshot s ON s.snapshot_id=e.snapshot_id WHERE e.status=\'pending\' AND s.version<=?)=0',[version,stamp,version,version]],
 ]);
 if(outcome==='conflict')return {ok:false,reason:'out_of_order'};
 if(outcome!=='ok')return {ok:false,reason:'unavailable'};
 let row;
 try{row=await one(db,'SELECT effects_drained_version FROM watchlist_current WHERE id=1');}catch{return {ok:false,reason:'unavailable'};}
 return {ok:true,drained:Number(row?.effects_drained_version)>=version};
}
// Counts a failed attempt of one effect without changing its status. -> {ok:true} | {ok:false,reason}
// `progress` (optional, 1..200 chars) is the writer's resume point of a long effect: it is kept in the pending row's `receipt` column (a pending effect has no receipt yet; `completeEffect` overwrites it with the final one),
// so an effect larger than one call can continue where it stopped instead of restarting from its beginning.
export async function recordEffectAttempt(source,{snapshotId,effect,progress},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(typeof snapshotId!=='string'||!ALL_EFFECTS.includes(effect))return {ok:false,reason:'shape'};
 const resume=progress==null?undefined:progress;
 if(resume!==undefined&&(typeof resume!=='string'||!resume||resume.length>200))return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,resume===undefined?['UPDATE watchlist_effect SET attempts=attempts+1 WHERE snapshot_id=? AND effect=? AND status=\'pending\'',[snapshotId,effect]]:['UPDATE watchlist_effect SET attempts=attempts+1, receipt=? WHERE snapshot_id=? AND effect=? AND status=\'pending\'',[resume,snapshotId,effect]]]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}

// ---- the admission ledger (ADR 0186 decision 5) ---------------------------------------------------------------------------
// The due rows of the durable ledger of Letterboxd ids that still need a Film: `pending` and due (`next_retry_at` null or past), oldest first-seen version first, bounded. Read only.
// AIR-599: the admission step no longer passes `ageBefore`/`ageVersions` (age does not end a row); it passes `overdueBefore` and reads the `overdue` count instead.
// `ageBefore` (an ISO time) and `ageVersions` select, REGARDLESS of their retry time, the pending rows whose first-seen snapshot is older than the age bound (committed before `ageBefore`; when that snapshot is
// already pruned, first seen at least `ageVersions` versions ago): they are returned as `aged` so the age bound cannot be postponed by a retry time in the future.
// `firstSeenAt` is the commit time of the snapshot that first listed the id; it is null when that snapshot was already pruned (then `currentVersion` still bounds its age by versions).
// -> {ok:true,rows:[{lid,firstSeenSnapshotId,firstSeenVersion,firstSeenAt,attempts,lastReason}],aged:[...same shape],pending,currentVersion} | {ok:false,reason}
export async function dueAdmissions(source,{now=Date.now(),limit=3,ageBefore=null,ageVersions=null,agedLimit=20,overdueBefore=null}={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const cap=Math.min(Math.max(Number.isInteger(limit)?limit:3,1),20);
 const shape=row=>({lid:row.lid,firstSeenSnapshotId:row.first_seen_snapshot_id,firstSeenVersion:Number(row.first_seen_version),firstSeenAt:row.first_seen_at??null,attempts:Number(row.attempts),lastReason:row.last_reason,updatedAt:row.updated_at});
 const COLUMNS='a.lid AS lid, a.first_seen_snapshot_id AS first_seen_snapshot_id, a.first_seen_version AS first_seen_version, a.attempts AS attempts, a.last_reason AS last_reason, a.updated_at AS updated_at, s.committed_at AS first_seen_at';
 try{
  const rows=await many(db,"SELECT "+COLUMNS+" FROM watchlist_admission_pending a LEFT JOIN watchlist_snapshot s ON s.snapshot_id=a.first_seen_snapshot_id WHERE a.state='pending' AND (a.next_retry_at IS NULL OR a.next_retry_at<=?) ORDER BY a.first_seen_version, a.lid LIMIT ?",[iso(now),cap]);
  const total=Number((await one(db,"SELECT COUNT(*) AS n FROM watchlist_admission_pending WHERE state='pending'"))?.n);
  const version=Number((await one(db,'SELECT version FROM watchlist_current WHERE id=1'))?.version);
  let aged=[];
  if(typeof ageBefore==='string'&&Number.isFinite(Date.parse(ageBefore))&&Number.isInteger(ageVersions)&&ageVersions>0&&Number.isInteger(version)){
   aged=(await many(db,"SELECT "+COLUMNS+" FROM watchlist_admission_pending a LEFT JOIN watchlist_snapshot s ON s.snapshot_id=a.first_seen_snapshot_id WHERE a.state='pending' AND ((s.committed_at IS NOT NULL AND s.committed_at<?) OR (s.committed_at IS NULL AND a.first_seen_version<=?)) ORDER BY a.first_seen_version, a.lid LIMIT ?",[ageBefore,version-ageVersions,Math.min(Math.max(Number.isInteger(agedLimit)?agedLimit:20,1),50)])).map(shape);
  }
  // AIR-599: the number of pending rows whose first-seen snapshot committed before `overdueBefore` (reported, never terminated). A pruned snapshot is not counted here.
  let overdue=null,overdueUnknown=null;
  if(typeof overdueBefore==='string'&&Number.isFinite(Date.parse(overdueBefore))){
   const row=await one(db,"SELECT COALESCE(SUM(s.committed_at<?),0) AS late, COALESCE(SUM(s.snapshot_id IS NULL),0) AS unknown FROM watchlist_admission_pending a LEFT JOIN watchlist_snapshot s ON s.snapshot_id=a.first_seen_snapshot_id WHERE a.state='pending'",[overdueBefore]);
   overdue=Number(row?.late)||0;overdueUnknown=Number(row?.unknown)||0;
  }
  return {ok:true,rows:rows.map(shape),aged,pending:total,overdue,overdueUnknown,currentVersion:Number.isInteger(version)?version:null};
 }catch{return {ok:false,reason:'unavailable'};}
}
// The ledger as the owner's identity work inventory reads it (ADR 0170): rows with the title and year of the film as its first-seen snapshot listed it, in keyset order (first-seen version, lid), READ PAGE BY PAGE.
// The filter is part of the SQL, never applied after a LIMIT: `filter` is one of `owner_review` (terminal), `waiting` (pending, retry time in the future), `retryable` (pending, due), `history` (resolved and
// superseded), `open` (pending and terminal) or `all`, and `after` is the keyset position `{version, lid}` of the last row of the previous page (null: the start). A page is `limit` rows; `more` says another page exists.
// `generation` is the Watchlist authority generation read in the same call, so a cursor can refuse to cross an authority switch. Read only.
// -> {ok:true,rows:[{lid,state,attempts,nextRetryAt,lastReason,resolvedBy,firstSeenSnapshotId,firstSeenVersion,firstSeenAt,updatedAt,title,year}],more,generation} | {ok:false,reason}
export const ADMISSION_FILTERS=['owner_review','waiting','retryable','history','open','all'];
export async function admissionInventory(source,{filter='open',after=null,limit=25,now=Date.now()}={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!ADMISSION_FILTERS.includes(filter))return {ok:false,reason:'shape'};
 if(after!==null&&!(Number.isInteger(after?.version)&&after.version>=0&&typeof after.lid==='string'))return {ok:false,reason:'shape'};
 const cap=Math.min(Math.max(Number.isInteger(limit)?limit:25,1),100);
 const where={owner_review:"a.state='terminal'",waiting:"a.state='pending' AND a.next_retry_at IS NOT NULL AND a.next_retry_at>?",retryable:"a.state='pending' AND (a.next_retry_at IS NULL OR a.next_retry_at<=?)",history:"a.state IN ('resolved','superseded')",open:"a.state IN ('pending','terminal')",all:'1=1'}[filter];
 const params=filter==='waiting'||filter==='retryable'?[iso(now)]:[];
 try{
  const gate=await one(db,'SELECT generation FROM watchlist_authority WHERE id=1');
  const keyset=after?' AND (a.first_seen_version>? OR (a.first_seen_version=? AND a.lid>?))':'';
  const rows=await many(db,"SELECT a.lid AS lid, a.state AS state, a.attempts AS attempts, a.next_retry_at AS next_retry_at, a.last_reason AS last_reason, a.resolved_by AS resolved_by, a.first_seen_snapshot_id AS first_seen_snapshot_id, a.first_seen_version AS first_seen_version, a.updated_at AS updated_at, s.committed_at AS first_seen_at, m.title AS title, m.year AS year FROM watchlist_admission_pending a LEFT JOIN watchlist_snapshot s ON s.snapshot_id=a.first_seen_snapshot_id LEFT JOIN watchlist_member m ON m.snapshot_id=a.first_seen_snapshot_id AND m.lid=a.lid WHERE "+where+keyset+" ORDER BY a.first_seen_version, a.lid LIMIT ?",[...params,...(after?[after.version,after.version,after.lid]:[]),cap+1]);
  return {ok:true,more:rows.length>cap,generation:Number(gate?.generation??0),rows:rows.slice(0,cap).map(row=>({lid:row.lid,state:row.state,attempts:Number(row.attempts),nextRetryAt:row.next_retry_at??null,lastReason:row.last_reason??null,resolvedBy:row.resolved_by??null,firstSeenSnapshotId:row.first_seen_snapshot_id,firstSeenVersion:Number(row.first_seen_version),firstSeenAt:row.first_seen_at??null,updatedAt:row.updated_at,title:row.title??null,year:row.year==null?null:Number(row.year)}))};
 }catch{return {ok:false,reason:'unavailable'};}
}
// One ledger transition of a `pending` row: still pending with a new retry time (a rate limit does not count an attempt: the caller passes the unchanged count), `resolved` with the writer's receipt
// reference, or `terminal` (no further automatic retry). Guarded by the authority and the caller's own guards. A row that is no longer pending is left alone (`already`).
// -> {ok:true,state} | {ok:true,already:true} | {ok:false,reason}
// AIR-599 (third review of PR #1009): the guard statement of a due row's token. It rides in the SAME batch as any write of the shared check document that applies this row's budget (its seed), so a seed read before an owner
// `requeue` or `dismiss` can never be installed after it: the batch fails (rolls back) while the row no longer holds the token. [sql, params] for the Ratings document store's `extra`.
export function admissionRowGuard({lid,attempts,updatedAt}){
 if(typeof lid!=='string'||!lid||!Number.isInteger(attempts)||typeof updatedAt!=='string'||!updatedAt)return null;
 return [GUARD("(SELECT COUNT(*) FROM watchlist_admission_pending WHERE lid=? AND state='pending' AND attempts=? AND updated_at=?)"+'=1'),[lid,attempts,updatedAt]];
}
// AIR-599 (review of PR #1009): `expect: {attempts, updatedAt}` is the token of the row as the caller READ it. With it the transition is installed only while the row still holds that token (a fence fails the batch otherwise:
// `{ok:false,reason:'conflict'}`), so a step that finished its check while an owner `requeue` or `dismiss` changed the row cannot overwrite the owner's decision.
export async function settleAdmission(source,{lid,state,attempts,nextRetryAt=null,reason=null,resolvedBy=null,now=Date.now(),expect=null},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(typeof lid!=='string'||!lid||!['pending','resolved','terminal'].includes(state)||!Number.isInteger(attempts)||attempts<0)return {ok:false,reason:'shape'};
 if(expect!==null&&(!Number.isInteger(expect.attempts)||typeof expect.updatedAt!=='string'||!expect.updatedAt))return {ok:false,reason:'shape'};
 if(state==='resolved'&&(typeof resolvedBy!=='string'||!resolvedBy||resolvedBy.length>200))return {ok:false,reason:'shape'};
 if(nextRetryAt!==null&&!Number.isFinite(Date.parse(nextRetryAt)))return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  ["UPDATE watchlist_admission_pending SET state=?, attempts=?, next_retry_at=?, last_reason=?, resolved_by=?, updated_at=? WHERE lid=? AND state='pending'"+(expect?' AND attempts=? AND updated_at=?':''),[state,attempts,state==='pending'?nextRetryAt:null,reason==null?null:String(reason).slice(0,60),state==='resolved'?resolvedBy:null,iso(now),lid,...(expect?[expect.attempts,expect.updatedAt]:[])]],
  ...(expect?[[FENCE,[]]]:[])]);
 if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
 try{const row=await one(db,'SELECT state FROM watchlist_admission_pending WHERE lid=?',[lid]);return row?.state===state?{ok:true,state}:{ok:true,already:true};}catch{return {ok:false,reason:'unavailable'};}
}
// AIR-599: the film URLs the CURRENT Watchlist snapshot lists for some ids (read only): the authoritative same-lid evidence of the film slug when the first-seen snapshot is pruned. A pending id that left the list
// is not returned (it is superseded by the removal effect). -> {ok:true,urls:Map<lid,url>} | {ok:false,reason:'unavailable'}
export async function currentMemberUrls(source,lids){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Array.isArray(lids)||!lids.length)return {ok:true,urls:new Map()};
 try{
  const rows=await many(db,'SELECT m.lid AS lid, m.url AS url FROM watchlist_member m JOIN watchlist_current c ON c.id=1 AND m.snapshot_id=c.snapshot_id WHERE m.lid IN ('+lids.map(()=>'?').join(',')+')',lids);
  return {ok:true,urls:new Map(rows.map(row=>[row.lid,row.url]))};
 }catch{return {ok:false,reason:'unavailable'};}
}
// AIR-599: the ledger facts of the Monitor (read only): pending rows that are due now, and pending rows whose first-seen snapshot committed before `overdueBefore` (reported, never terminated).
// -> {ok:true,pendingDue,overdue} | {ok:false,reason}
export async function admissionReport(source,{now=Date.now(),overdueBefore,retainedReasons=[]}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 try{
  // Work the shared check still owes an answer: rows due now, plus rows retained after a transport stop (their retry time may be in the future: they are still waiting, not done).
  const marks=retainedReasons.map(()=>'?').join(',');
  const workSql="a.state='pending' AND (a.next_retry_at IS NULL OR a.next_retry_at<=?"+(marks?' OR a.last_reason IN ('+marks+')':'')+')';
  const work=await one(db,"SELECT COUNT(*) AS n, MIN(s.committed_at) AS oldest, COALESCE(SUM(s.snapshot_id IS NULL),0) AS unknown FROM watchlist_admission_pending a LEFT JOIN watchlist_snapshot s ON s.snapshot_id=a.first_seen_snapshot_id WHERE "+workSql,[iso(now),...retainedReasons]);
  // LEFT JOIN: a row whose first-seen snapshot is gone (legacy rows pruned before AIR-599) has an UNKNOWN age; it is counted apart, never dropped from the report.
  const late=await one(db,"SELECT COALESCE(SUM(s.committed_at<?),0) AS late, COALESCE(SUM(s.snapshot_id IS NULL),0) AS unknown FROM watchlist_admission_pending a LEFT JOIN watchlist_snapshot s ON s.snapshot_id=a.first_seen_snapshot_id WHERE a.state='pending'",[overdueBefore]);
  return {ok:true,pendingDue:Number(work?.n)||0,oldestWorkAt:work?.oldest??null,overdue:Number(late?.late)||0,overdueUnknown:Number(late?.unknown)||0};
 }catch{return {ok:false,reason:'unavailable'};}
}
// AIR-599 / ADR 0207 decision 4b (review of PR #1009): the owner `requeue` and `dismiss` of ledger rows are PLANNED here and COMMITTED by the caller in the same D1 batch as the write of the shared Diary check document
// (`LetterboxdFacts.ownerAction(..., {extra: plan.statements})`), so the two stores change together or not at all. Existing columns only. Each statement carries the compare-and-swap token of its row (`state`, `attempts`,
// `updated_at`) and is followed by a fence that fails the whole batch when it matched no row. `requeue` sets a pending or terminal row back to `pending` (attempts 0, due now, `last_reason = owner_requeued`); a row terminal
// as `age_exceeded` only while its id is still on the current Watchlist. `dismiss` makes the row terminal as `owner_dismissed`.
// `rows` are the tokens the owner saw (watchlist lane); without them the CURRENT open rows of `lids` are read (an id with no open row has none, and a row that cannot be requeued by rule is skipped and named in `skipped`).
// -> {ok:true,statements,tokens,skipped} | {ok:false,reason:'shape'|'closed'|'writes_held'|'unavailable'}
export async function ownerAdmissionPlan(source,{action,lids,rows=null,now=Date.now()}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!['requeue','dismiss'].includes(action)||!Array.isArray(lids)||!lids.length||lids.length>50||lids.some(lid=>typeof lid!=='string'||!lid||lid.length>100))return {ok:false,reason:'shape'};
 if(rows!==null&&(!Array.isArray(rows)||rows.some(row=>!lids.includes(row?.lid)||!['pending','terminal'].includes(row.state)||!Number.isInteger(row.attempts)||row.attempts<0||typeof row.updatedAt!=='string'||!row.updatedAt)||new Set(rows.map(row=>row.lid)).size!==rows.length))return {ok:false,reason:'shape'};
 let gate;
 try{gate=await readAuthority(db);}catch{return {ok:false,reason:'unavailable'};}
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const onList="EXISTS (SELECT 1 FROM watchlist_member m JOIN watchlist_current c ON c.id=1 AND m.snapshot_id=c.snapshot_id WHERE m.lid=watchlist_admission_pending.lid)";
 const skipped=[];
 let tokens=rows;
 if(tokens===null){
  try{
   const read=await many(db,"SELECT lid,state,attempts,last_reason,updated_at,"+onList.replace('watchlist_admission_pending.lid','a.lid')+" AS on_list FROM watchlist_admission_pending a WHERE a.state IN ('pending','terminal') AND a.lid IN ("+lids.map(()=>'?').join(',')+')',lids);
   tokens=[];
   for(const row of read){
    if(action==='requeue'&&row.state==='terminal'&&row.last_reason==='age_exceeded'&&!row.on_list){skipped.push({lid:row.lid,reason:'not_on_watchlist'});continue;}
    tokens.push({lid:row.lid,state:row.state,attempts:Number(row.attempts),updatedAt:row.updated_at});
   }
  }catch{return {ok:false,reason:'unavailable'};}
 }
 const stamp=iso(now),statements=[];
 if(tokens.length)statements.push(authorityGuard(gate.generation));
 for(const row of tokens){
  if(action==='requeue')statements.push(["UPDATE watchlist_admission_pending SET state='pending', attempts=0, next_retry_at=NULL, last_reason='owner_requeued', resolved_by=NULL, updated_at=? WHERE lid=? AND state=? AND attempts=? AND updated_at=? AND state IN ('pending','terminal') AND (state='pending' OR last_reason IS NULL OR last_reason<>'age_exceeded' OR "+onList+")",[stamp,row.lid,row.state,row.attempts,row.updatedAt]]);
  else statements.push(["UPDATE watchlist_admission_pending SET state='terminal', next_retry_at=NULL, last_reason='owner_dismissed', resolved_by=NULL, updated_at=? WHERE lid=? AND state=? AND attempts=? AND updated_at=? AND state IN ('pending','terminal')",[stamp,row.lid,row.state,row.attempts,row.updatedAt]]);
  statements.push([FENCE,[]]);
 }
 return {ok:true,statements,tokens,skipped};
}
// The ledger rows of some ids as they stand now (the readback of an owner action). Read only.
// -> {ok:true,rows:[{lid,state,attempts,nextRetryAt,lastReason,updatedAt}]} | {ok:false,reason}
export async function admissionRowsOf(source,lids){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Array.isArray(lids)||!lids.length)return {ok:true,rows:[]};
 try{
  const read=await many(db,'SELECT lid,state,attempts,next_retry_at,last_reason,updated_at FROM watchlist_admission_pending WHERE lid IN ('+lids.map(()=>'?').join(',')+')',lids);
  return {ok:true,rows:read.map(row=>({lid:row.lid,state:row.state,attempts:Number(row.attempts),nextRetryAt:row.next_retry_at??null,lastReason:row.last_reason??null,updatedAt:row.updated_at}))};
 }catch{return {ok:false,reason:'unavailable'};}
}
// An id that left the Watchlist before it was resolved is `superseded` (not retried); a returning id reopens through the next promotion's ledger insert. -> {ok:true} | {ok:false,reason}
export async function supersedeAdmissions(source,{lids,now=Date.now()},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Array.isArray(lids)||lids.some(lid=>typeof lid!=='string'||!lid)||lids.length>50)return {ok:false,reason:'shape'};
 if(!lids.length)return {ok:true};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  ["UPDATE watchlist_admission_pending SET state='superseded', next_retry_at=NULL, updated_at=? WHERE state='pending' AND lid IN ("+lids.map(()=>'?').join(',')+')',[iso(now),...lids]]]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}

// ---- retention ------------------------------------------------------------------------------------------------------------
// The newest `keepSnapshots` promoted snapshots (with members, changes and effects) stay; older ones are deleted, but never a snapshot whose causal effects are not all done and never the current
// pointer. Bounded per call. -> {ok:true,removed} | {ok:false,reason}
export async function pruneSnapshots(source,ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 let old;
 try{old=await many(db,"SELECT snapshot_id FROM watchlist_snapshot WHERE version<=(SELECT COALESCE(MAX(version),0) FROM watchlist_snapshot)-? AND snapshot_id IS NOT (SELECT snapshot_id FROM watchlist_current WHERE id=1) AND snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_effect WHERE status<>'done') AND snapshot_id NOT IN ("+LEDGER_REFS+") ORDER BY version LIMIT 5",[LIMITS.keepSnapshots]);}
 catch{return {ok:false,reason:'unavailable'};}
 let removed=0;
 for(const row of old){
  const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
   ['DELETE FROM watchlist_effect WHERE snapshot_id=?',[row.snapshot_id]],
   ['DELETE FROM watchlist_change WHERE snapshot_id=?',[row.snapshot_id]],
   ['DELETE FROM watchlist_member WHERE snapshot_id=?',[row.snapshot_id]],
   ['DELETE FROM watchlist_snapshot WHERE snapshot_id=?',[row.snapshot_id]],
   ['DELETE FROM watchlist_staging WHERE snapshot_id=?',[row.snapshot_id]]]);
  if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
  removed++;
 }
 // AIR-599 (review of PR #1009): a snapshot a live ledger row names as its first sighting keeps its HEADER (version, commit time: the authoritative age of the queue place) after the rest is pruned; its members, changes and
 // effects are removed like any other old snapshot's. The 14-day report and the queue age therefore survive the retention bound. A header-only snapshot is not selected again (it has no members left to trim).
 let trimmed=0;
 try{
  const kept=await many(db,"SELECT s.snapshot_id AS snapshot_id FROM watchlist_snapshot s WHERE s.version<=(SELECT COALESCE(MAX(version),0) FROM watchlist_snapshot)-? AND s.snapshot_id IS NOT (SELECT snapshot_id FROM watchlist_current WHERE id=1) AND s.snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_effect WHERE status<>'done') AND s.snapshot_id IN ("+LEDGER_REFS+") AND (EXISTS (SELECT 1 FROM watchlist_member m WHERE m.snapshot_id=s.snapshot_id) OR EXISTS (SELECT 1 FROM watchlist_change c WHERE c.snapshot_id=s.snapshot_id) OR EXISTS (SELECT 1 FROM watchlist_effect e WHERE e.snapshot_id=s.snapshot_id)) ORDER BY s.version LIMIT 5",[LIMITS.keepSnapshots]);
  for(const row of kept){
   const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
    ['DELETE FROM watchlist_effect WHERE snapshot_id=?',[row.snapshot_id]],
    ['DELETE FROM watchlist_change WHERE snapshot_id=?',[row.snapshot_id]],
    ['DELETE FROM watchlist_member WHERE snapshot_id=?',[row.snapshot_id]]]);
   if(outcome!=='ok')return {ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
   trimmed++;
  }
 }catch{return {ok:false,reason:'unavailable'};}
 return {ok:true,removed,trimmed};
}

// ---- the canonical membership projection (ADR 0203, AIR-582, schema 37) ------------------------------------------------------
// Storage only: the marker of WHO writes `watchlist_film`, the durable non-blocking handoff ledger of Letterboxd ids whose Film is not resolvable yet, and the two guarded steps of the rollout (baseline proof, switch).
// The writes of `watchlist_film` itself and of its per-film version fence belong to the Film writer (`setFilmMembership`), under the Film/Person marker, never here.
export const HANDOFF_MAX_ATTEMPTS=12;
export const HANDOFF_BATCH=50;
const MEMBERSHIP_CHECK="(SELECT COUNT(*) FROM watchlist_current WHERE id=1 AND version=? AND effects_drained_version=version)";
// -> {ok:true,present:false} (schema below 37: legacy, the Producer owns membership) | {ok:true,present:true,mode,generation,baselineVersion} | {ok:false}
export async function readMembershipAuthority(source){
 const db=database(source);
 if(!db)return {ok:false};
 let row;
 try{row=await one(db,'SELECT mode, generation, baseline_version FROM watchlist_membership_authority WHERE id=1');}
 catch(error){return /no such table/i.test(String(error?.message||error))?{ok:true,present:false}:{ok:false};}
 if(!row||(row.mode!=='producer'&&row.mode!=='sync')||!Number.isInteger(Number(row.generation)))return {ok:false};
 return {ok:true,present:true,mode:row.mode,generation:Number(row.generation),baselineVersion:row.baseline_version==null?null:Number(row.baseline_version)};
}
// The current version and the Letterboxd ids of the CURRENT snapshot (the only truth a late reconcile may apply). -> {ok:true,version,snapshotId,lids:Set,effectsDrainedVersion} | {ok:false,reason}
export async function readCurrentMembers(source){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 try{
  const pointer=await one(db,CURRENT_SQL);
  if(!pointer)return {ok:false,reason:'malformed'};
  const rows=pointer.snapshot_id?await many(db,'SELECT lid FROM watchlist_member WHERE snapshot_id=?',[pointer.snapshot_id]):[];
  return {ok:true,version:Number(pointer.version),snapshotId:pointer.snapshot_id??null,lids:new Set(rows.map(row=>row.lid)),effectsDrainedVersion:Number(pointer.effects_drained_version)};
 }catch{return {ok:false,reason:'unavailable'};}
}
// Opens (or re-opens) the handoff of ADDED ids that could not be applied now. A pending row keeps its attempts; a settled or terminal one is re-opened by a new addition. -> {ok:true} | {ok:false,reason}
export async function recordMembershipHandoff(source,{lids,version,reason='unresolved',now=Date.now()},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Array.isArray(lids)||lids.length>HANDOFF_BATCH||lids.some(lid=>typeof lid!=='string'||!lid||lid.length>100)||!Number.isInteger(version)||version<1)return {ok:false,reason:'shape'};
 if(!lids.length)return {ok:true};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const stamp=iso(now),why=String(reason).slice(0,60);
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  ...lids.map(lid=>["INSERT INTO watchlist_membership_handoff (lid, first_version, state, attempts, next_retry_at, reason, updated_at) VALUES (?,?,'pending',0,NULL,?,?) ON CONFLICT(lid) DO UPDATE SET state='pending', first_version=excluded.first_version, attempts=0, next_retry_at=NULL, reason=excluded.reason, updated_at=excluded.updated_at WHERE state IN ('settled','terminal')",[lid,version,why,stamp]])]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}
// Hands EVERY change row of a version beyond `offset` (in the stored order of `readChanges`: added, then removed) to the durable handoff ledger in ONE set-based statement, without reading, resolving or writing a Film.
// This is what lets the `membership` effect complete in a bounded number of calls however large a valid version diff is (up to 500 additions, because of the admission ledger cap, and up to 5000 removals), so routine
// catch-up never starves the next 4/day scan behind the strict drain-before-scan rule. A pending row keeps its state; a settled or terminal one is re-opened. -> {ok:true} | {ok:false,reason}
export async function handoffVersionRemainder(source,{snapshotId,version,offset,reason='remainder',now=Date.now()},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(typeof snapshotId!=='string'||!snapshotId||!Number.isInteger(version)||version<1||!Number.isInteger(offset)||offset<0)return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  ["INSERT INTO watchlist_membership_handoff (lid, first_version, state, attempts, next_retry_at, reason, updated_at) SELECT lid, ?, 'pending', 0, NULL, ?, ? FROM (SELECT lid FROM watchlist_change WHERE snapshot_id=? ORDER BY kind, COALESCE(ordinal, prev_ordinal) LIMIT -1 OFFSET ?) WHERE true ON CONFLICT(lid) DO UPDATE SET state='pending', first_version=excluded.first_version, attempts=0, next_retry_at=NULL, reason=excluded.reason, updated_at=excluded.updated_at WHERE state IN ('settled','terminal')",[version,String(reason).slice(0,60),iso(now),snapshotId,offset]]]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}
// The due pending rows, oldest first. Read only. -> {ok:true,rows:[{lid,firstVersion,attempts,reason}],pending,terminal} | {ok:false,reason}
export async function dueMembershipHandoffs(source,{now=Date.now(),limit=8}={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 try{
  const rows=await many(db,"SELECT lid, first_version, attempts, reason FROM watchlist_membership_handoff WHERE state='pending' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY first_version, lid LIMIT ?",[iso(now),Math.max(1,Math.min(HANDOFF_BATCH,limit))]);
  const counts=await one(db,"SELECT COALESCE(SUM(state='pending'),0) AS pending, COALESCE(SUM(state='terminal'),0) AS terminal FROM watchlist_membership_handoff");
  return {ok:true,rows:rows.map(row=>({lid:row.lid,firstVersion:Number(row.first_version),attempts:Number(row.attempts),reason:row.reason??null})),pending:Number(counts?.pending??0),terminal:Number(counts?.terminal??0)};
 }catch(error){return /no such table/i.test(String(error?.message||error))?{ok:true,rows:[],pending:0,terminal:0}:{ok:false,reason:'unavailable'};}
}
// Settles one pending row: `settled` (applied against the current snapshot), `terminal` (bounded attempts spent: waits for the baseline operator or an owner decision, nothing is guessed) or `pending` with a backoff.
export async function settleMembershipHandoff(source,{lid,state,attempts,nextRetryAt=null,reason=null,now=Date.now()},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(typeof lid!=='string'||!lid||!['pending','settled','terminal'].includes(state)||!Number.isInteger(attempts)||attempts<0)return {ok:false,reason:'shape'};
 if(nextRetryAt!==null&&!Number.isFinite(Date.parse(nextRetryAt)))return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  ["UPDATE watchlist_membership_handoff SET state=?, attempts=?, next_retry_at=?, reason=?, updated_at=? WHERE lid=? AND state='pending'",[state,attempts,state==='pending'?nextRetryAt:null,reason==null?null:String(reason).slice(0,60),iso(now),lid]]]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}
// ROLLOUT STEP 1 (owner GO): records that the one-time baseline reconciliation proved `watchlist_film` equal to Watchlist version `version`. Only while the marker is `producer`, only for the exact current version with every
// effect drained; the marker row keeps its mode and generation. -> {ok:true} | {ok:false,reason}
export async function recordMembershipBaseline(source,{version,now=Date.now()},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Number.isInteger(version)||version<0)return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  [GUARD("CASE WHEN (SELECT COUNT(*) FROM watchlist_membership_authority WHERE id=1 AND mode='producer')=1 AND "+MEMBERSHIP_CHECK+"=1 THEN 1 ELSE 0 END"),[version]],
  ["UPDATE watchlist_membership_authority SET baseline_version=?, changed_at=? WHERE id=1 AND mode='producer'",[version,iso(now)]]]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}
// ROLLOUT STEP 2 (owner GO): the switch of the writer. Refused unless the marker is `producer` at `expectedGeneration`, the baseline proof names exactly the current version and every effect of it is drained. After it the
// promotions carry the `membership` effect and the Film writer refuses every Producer membership write. Roll-forward only (there is no switch back in this change). -> {ok:true} | {ok:false,reason}
export async function activateMembershipSync(source,{expectedGeneration,version,now=Date.now()},ctx={}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!Number.isInteger(expectedGeneration)||expectedGeneration<0||!Number.isInteger(version)||version<1)return {ok:false,reason:'shape'};
 const extra=callerGuards(ctx);
 if(!extra)return {ok:false,reason:'shape'};
 const gate=await readAuthority(db);
 if(gate.state!=='d1')return {ok:false,reason:'closed'};
 if(gate.writes!=='open')return {ok:false,reason:'writes_held'};
 const outcome=await fenced(db,[authorityGuard(gate.generation),...extra,
  [GUARD("CASE WHEN (SELECT COUNT(*) FROM watchlist_membership_authority WHERE id=1 AND mode='producer' AND generation=? AND baseline_version=?)=1 AND "+MEMBERSHIP_CHECK+"=1 THEN 1 ELSE 0 END"),[expectedGeneration,version,version]],
  ["UPDATE watchlist_membership_authority SET mode='sync', generation=generation+1, changed_at=? WHERE id=1 AND mode='producer' AND generation=?",[iso(now),expectedGeneration]]]);
 return outcome==='ok'?{ok:true}:{ok:false,reason:outcome==='conflict'?'conflict':'unavailable'};
}
