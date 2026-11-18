// ADR 0079, ADR 0162. The published programme generation, its pointer, show rows and
// watchlist membership. The nine tables plus the marker are the authority.
// 0008 runs only after the prediction contract is version 7, and it leaves
// version 8. Only mode d1 with cutover open is served: a marker in mode r2 or with
// cutover held, a partly installed set of tables, a published table below version 8,
// no tables at all, a missing binding and a bound database with no schema_contract all
// fail closed with published_epg_unavailable, never as a read of the R2 generation.
// The explicit local stand-in is the caller setting PUBLISHED_EPG_DB_OPTIONAL to
// standin: it serves the R2 generation when the domain is not installed at all, that is no
// binding, no schema_contract, or a contract below 8 with none of the tables. Mode d1 with cutover open reads and
// writes these tables and does not fall back to a different R2 generation.
// This module does not import. The Worker bundle wraps it.
// The publisher uses the Worker binding's batch. It does not send the offline
// REST body, and it does not write Film, candidate or prediction rows.

export const CHUNK_STATEMENTS=950;
export const CHUNK_BYTES=1000000;
export const MAX_STATEMENT_BYTES=90000;
export const DOCUMENT_BYTES=60000;
export const CLAIM_TTL_MS=15*60*1000;
const POINTER_KEY='epg/published-generation.json';
const PROGRAMME_KEY='programme.json';
const WATCHLIST_KEY='watchlist.json';
const FENCE_SQL='UPDATE published_epg_cas SET ok=changes() WHERE id=1';
// AIR-348 / ADR 0100. An EPG executor or external-path commit carries `epgFence: {revision}`: the revision of the executor
// `mode` document as read at admission (null: no document yet, the default external mode). The commit batch asserts it in
// its own statement, so a commit admitted before the owner closed admission cannot land after it. ok=0 trips CHECK (ok = 1).
function epgFenceStatements(fence){
 if(fence==null)return [];
 if(!(fence.revision===null||(Number.isInteger(fence.revision)&&fence.revision>=1)))throw failed('published_epg_fence');
 return [["UPDATE published_epg_cas SET ok=CASE WHEN (SELECT COUNT(*) FROM epg_orchestration_document WHERE key='mode' AND (? IS NULL OR revision=?))=? THEN 1 ELSE 0 END WHERE id=1",[fence.revision,fence.revision,fence.revision===null?0:1]]];
}
const RESERVED_STATEMENTS=3;
const TABLES=['published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'];

export function generationObjectKey(runId,name){return 'epg/generations/'+runId+'/'+name;}

function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function binding(db){return typeof db?.prepare==='function';}
function database(env){return env&&typeof env.prepare==='function'?env:env?.DB;}
async function one(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).first())??null;
 return (await db.get(sql,params))??null;
}
async function many(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).all()).results||[];
 return (await db.all(sql,params))||[];
}
async function fenced(db,statements){
 if(typeof db.batch!=='function')throw failed('published_epg_unavailable');
 if(statements.some(([,params])=>params.length>100))throw failed('published_epg_unavailable');
 const prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));
 try{await db.batch(prepared);}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message))throw failed('published_epg_fence',error);
  if(/UNIQUE constraint failed/i.test(message))throw failed('published_epg_conflict',error);
  throw failed('published_epg_unavailable',error);
 }
}
function bytesOf(sql,params){
 let size=new TextEncoder().encode(sql).length;
 for(const value of params)size+=value==null?4:new TextEncoder().encode(String(value)).length+2;
 return size;
}
async function digest(text){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function splitText(text,maxBytes){
 const encoded=new TextEncoder().encode(text);
 const parts=[];
 let start=0;
 while(start<encoded.length){
  let end=Math.min(encoded.length,start+maxBytes);
  if(end<encoded.length){while(end>start&&(encoded[end]&0b11000000)===0b10000000)end--;if(end===start)throw failed('published_epg_programme');}
  parts.push(new TextDecoder().decode(encoded.subarray(start,end)));
  start=end;
 }
 if(!parts.length)parts.push('');
 return parts;
}
function requiredId(film,code){
 const id=film?.id==null?'':String(film.id);
 if(!id)throw failed(code);
 return id;
}

// The live programme stores start/end. The repository contract stores startMs/endMs.
// A film with no shows, or shows: [], is an explicit empty list: a member and no show rows.
export function programmeShows(films){
 const shows=[];
 for(const film of films||[]){
  const filmId=requiredId(film,'published_epg_film');
  const seen=new Set();
  for(const show of Array.isArray(film.shows)?film.shows:[]){
   const start=Number(show?.startMs??show?.start);
   const channelId=show?.channelId==null?'':String(show.channelId);
   if(!channelId||!Number.isFinite(start))throw failed('published_epg_show');
   const key=channelId+'\n'+start;
   if(seen.has(key))continue;
   seen.add(key);
   const end=show.endMs??show.end??null;
   shows.push({filmId,channelId,channel:show.channel??null,startMs:start,endMs:end==null||!Number.isFinite(Number(end))?null:Number(end),epgTitle:show.epgTitle??null,basis:show.basis??null,matchReason:show.matchReason??null});
  }
 }
 return shows;
}
function membersOf(kind,films){
 const seen=new Set();
 return (films||[]).map((film,ordinal)=>{
  const filmId=requiredId(film,'published_epg_film');
  if(seen.has(filmId))throw failed('published_epg_conflict');
  seen.add(filmId);
  return {kind,ordinal,filmId};
 });
}
function documentRows(kind,text){
 return splitText(text,DOCUMENT_BYTES).map((part,ordinal)=>({kind:'document',docKind:kind,ordinal,text:part}));
}
function logicalRows(programme,watchlist,programmeText,watchlistText){
 const programmeFilms=Array.isArray(programme?.films)?programme.films:null;
 const watchFilms=Array.isArray(watchlist?.films)?watchlist.films:null;
 if(!programmeFilms)throw failed('published_epg_programme');
 if(!watchFilms)throw failed('published_epg_watchlist');
 const members=[...membersOf('programme',programmeFilms),...membersOf('watchlist',watchFilms)];
 const shows=programmeShows(programmeFilms);
 const documents=[...documentRows('programme',programmeText),...documentRows('watchlist',watchlistText)];
 return {members,shows,documents};
}
function statementFor(stageId,chunk,ordinal,row){
 if(row.kind==='member')return ['INSERT INTO published_epg_stage_row (programme_run_id,chunk_index,ordinal,kind,doc_kind,item_ordinal,film_id) VALUES (?,?,?,?,?,?,?)',[stageId,chunk,ordinal,'member',row.memberKind,row.ordinal,row.filmId]];
 if(row.kind==='show')return ['INSERT INTO published_epg_stage_row (programme_run_id,chunk_index,ordinal,kind,item_ordinal,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[stageId,chunk,ordinal,'show',ordinal,row.filmId,row.channelId,row.channel,row.startMs,row.endMs,row.epgTitle,row.basis,row.matchReason]];
 return ['INSERT INTO published_epg_stage_row (programme_run_id,chunk_index,ordinal,kind,doc_kind,item_ordinal,payload_json) VALUES (?,?,?,?,?,?,?)',[stageId,chunk,ordinal,'document',row.docKind,row.ordinal,row.text]];
}
function pack(stageId,rows,statementCap,byteCap){
 if(statementCap<=RESERVED_STATEMENTS)throw failed('published_epg_unavailable');
 const chunks=[];
 let current=[];
 let bytes=2048;
 const room=statementCap-RESERVED_STATEMENTS;
 const push=()=>{if(current.length)chunks.push(current);current=[];bytes=2048;};
 rows.forEach((row,index)=>{
  const statement=statementFor(stageId,chunks.length,current.length,row);
  const size=bytesOf(statement[0],statement[1]);
  if(size>MAX_STATEMENT_BYTES)throw failed('published_epg_show');
  if(current.length>=room||bytes+size>byteCap)push();
  const placed=statementFor(stageId,chunks.length,current.length,row);
  const placedSize=bytesOf(placed[0],placed[1]);
  current.push({row,statement:placed,index});
  bytes+=placedSize;
 });
 push();
 if(!chunks.length)chunks.push([]);
 return chunks;
}

export function advancedFence(before,after){
 const left=/^d1:(\d+):(.*)$/.exec(String(before??''));
 const right=/^d1:(\d+):(.*)$/.exec(String(after??''));
 if(!left||!right||left[2]!==right[2])return false;
 return Number(right[1])===Number(left[1])+1;
}

export async function readAuthority(db){
 const target=database(db);
 if(!target){
  if(db?.PUBLISHED_EPG_DB_OPTIONAL==='standin')return {mode:'r2',tables:false,version:null,ready:false};
  throw failed('published_epg_unavailable');
 }
 // The published tables are inventoried first, so that no stand-in path below can serve R2 over a partly installed domain, whatever the contract says.
 let names;
 try{names=(await many(target,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'published_epg%'")).map(row=>row.name);}
 catch(error){throw failed('published_epg_unavailable',error);}
 const tables=TABLES.every(name=>names.includes(name));
 const standin=db?.PUBLISHED_EPG_DB_OPTIONAL==='standin';
 if(!tables&&names.length>0)throw failed('published_epg_unavailable');
 let version;
 try{version=(await one(target,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(!tables&&/no such table/i.test(String(error?.message||error))&&standin)return {mode:'r2',tables:false,version:null,ready:false};
  throw failed('published_epg_unavailable',error);
 }
 if(!tables){
  const numeric=Number(version);
  if(!standin)throw failed('published_epg_unavailable');
  if(version==null||!Number.isFinite(numeric))return {mode:'r2',tables:false,version:null,ready:false};
  // A contract at 8 or later declares the domain installed: none of its tables is a broken install, not an uninstalled domain.
  if(numeric>=8)throw failed('published_epg_unavailable');
  return {mode:'r2',tables:false,version:numeric,ready:false};
 }
 if(!(Number(version)>=8))throw failed('published_epg_unavailable');
 let row;
 try{row=await one(target,'SELECT mode, cutover, programme_run_id AS programmeRunId, generation, mirror_programme_run_id AS mirrorProgrammeRunId, mirror_etag AS mirrorEtag, watchlist_generation AS watchlistGeneration, mirror_watchlist_etag AS mirrorWatchlistEtag FROM published_epg_authority WHERE id=1');}
 catch(error){throw failed('published_epg_unavailable',error);}
 // ADR 0162: only d1 / open is served. The retired cutover left r2 and held states behind; a restored marker in either is refused, not read as the R2 mirrors.
 if(!row||row.mode!=='d1'||row.cutover!=='open')throw failed('published_epg_unavailable');
 return {mode:'d1',cutover:'open',tables:true,version:Number(version),ready:true,programmeRunId:row.programmeRunId??null,generation:Number(row.generation),mirrorProgrammeRunId:row.mirrorProgrammeRunId??null,mirrorEtag:row.mirrorEtag??null,watchlistGeneration:Number(row.watchlistGeneration),mirrorWatchlistEtag:row.mirrorWatchlistEtag??null};
}

export async function currentGeneration(env){
 const authority=await readAuthority(env);
 if(!authority.ready)return null;
 const programmeRunId=authority.programmeRunId;
 return {authority:'d1',programmeRunId,phase:programmeRunId?'published':null,generation:authority.generation,fence:'d1:'+authority.generation+':'+(programmeRunId||''),mirrorProgrammeRunId:authority.mirrorProgrammeRunId,mirrorEtag:authority.mirrorEtag,mirrorWatchlistEtag:authority.mirrorWatchlistEtag,watchlistGeneration:authority.watchlistGeneration,mirrors:{aligned:!!programmeRunId&&authority.mirrorProgrammeRunId===programmeRunId&&!!authority.mirrorEtag&&!!authority.mirrorWatchlistEtag}};
}

export async function readDocument(env,programmeRunId,kind){
 if(kind!=='programme'&&kind!=='watchlist')throw failed('published_epg_programme');
 const db=database(env);
 let rows;
 try{rows=await many(db,'SELECT ordinal, payload_json FROM published_epg_document WHERE programme_run_id=? AND kind=? ORDER BY ordinal',[programmeRunId,kind]);}
 catch(error){throw failed('published_epg_unavailable',error);}
 if(!rows.length)return null;
 let text='';
 for(let index=0;index<rows.length;index++){if(Number(rows[index].ordinal)!==index)throw failed('published_epg_unavailable');text+=rows[index].payload_json;}
 try{return JSON.parse(text);}
 catch{throw failed('published_epg_unavailable');}
}
// ADR 0142 decisions 11 and 12. The sealed read (`readDocument`) is the stored document and is internal to publication. The completed read adds the rows Discovery assigned to
// the run (`basis = 'discovery'`) in ONE statement: the shows of each member are completed (sorted by start and channel, `availableUntil` recomputed) and the Films of the run
// that are not members are listed as `catalogFilms` with identity and shows only. With no assigned row the completed programme is the sealed document, byte for byte.
const ASSIGNED_SHOWS_SQL="SELECT film_id, channel_id, channel, start_ms, end_ms, match_reason FROM published_epg_show WHERE programme_run_id=? AND basis='discovery' ORDER BY start_ms, channel_id, film_id";
const AVAILABLE_MS=72*3600000;
export function completeProgramme(sealed,rows){
 if(!sealed||!Array.isArray(sealed.films)||!rows?.length)return sealed;
 const byFilm=new Map();
 for(const row of rows){
  const id=String(row.film_id);
  const list=byFilm.get(id)||[];
  list.push({channelId:row.channel_id,channel:row.channel??null,start:Number(row.start_ms),end:row.end_ms==null?null:Number(row.end_ms),epgTitle:null,basis:'discovery',matchReason:row.match_reason??null});
  byFilm.set(id,list);
 }
 const members=new Set(sealed.films.map(film=>String(film?.id)));
 const order=(a,b)=>a.start-b.start||String(a.channelId).localeCompare(String(b.channelId));
 const films=sealed.films.map(film=>{
  const extra=byFilm.get(String(film?.id));
  if(!extra)return film;
  const seen=new Set(),shows=[];
  for(const show of [...(Array.isArray(film.shows)?film.shows:[]),...extra]){
   const start=Number(show.start??show.startMs),key=String(show.channelId)+'\n'+start;
   if(seen.has(key))continue;
   seen.add(key);shows.push(show);
  }
  shows.sort((a,b)=>order({start:Number(a.start??a.startMs),channelId:a.channelId},{start:Number(b.start??b.startMs),channelId:b.channelId}));
  const starts=shows.map(show=>Number(show.start??show.startMs)).filter(Number.isFinite);
  return {...film,shows,availableUntil:starts.length?new Date(Math.max(...starts)+AVAILABLE_MS).toISOString():null};
 });
 const catalogFilms=[];
 for(const [id,shows] of byFilm){
  if(members.has(id))continue;
  const tmdb=/^tmdb_(\d+)$/.exec(id)?.[1]??null;
  catalogFilms.push({id,tmdbId:tmdb,canonicalIdentity:tmdb?'tmdb:'+tmdb:null,shows:shows.sort(order)});
 }
 catalogFilms.sort((a,b)=>a.shows[0].start-b.shows[0].start||a.id.localeCompare(b.id));
 return {...sealed,films,catalogFilms};
}
export async function readCompletedProgramme(env,programmeRunId){
 const sealed=await readDocument(env,programmeRunId,'programme');
 if(!sealed)return null;
 let rows;
 try{rows=await many(database(env),ASSIGNED_SHOWS_SQL,[programmeRunId]);}
 catch(error){throw failed('published_epg_unavailable',error);}
 return completeProgramme(sealed,rows);
}
async function readDocumentCompleted(env,programmeRunId,kind){
 return kind==='programme'?readCompletedProgramme(env,programmeRunId):readDocument(env,programmeRunId,kind);
}
export async function readDocumentAt(env,programmeRunId,kind,generation){
 const opened=await currentGeneration(env);
 if(!opened||opened.programmeRunId!==programmeRunId||opened.generation!==generation)throw failed('published_epg_fence');
 const document=await readDocumentCompleted(env,programmeRunId,kind);
 const closed=await currentGeneration(env);
 if(!closed||closed.generation!==generation||closed.programmeRunId!==programmeRunId)throw failed('published_epg_fence');
 return document;
}
export async function readShows(env,programmeRunId){
 const rows=await many(database(env),'SELECT film_id, channel_id, channel, start_ms, end_ms, epg_title, basis, match_reason FROM published_epg_show WHERE programme_run_id=? ORDER BY film_id, start_ms, channel_id',[programmeRunId]);
 return rows.map(row=>({filmId:row.film_id,channelId:row.channel_id,channel:row.channel??null,startMs:Number(row.start_ms),endMs:row.end_ms==null?null:Number(row.end_ms),epgTitle:row.epg_title??null,basis:row.basis??null,matchReason:row.match_reason??null}));
}
// AIR-531: is there a D1 binding to read at all (the worker never names the binding itself).
export function hasDatabase(env){return !!database(env);}
// AIR-531: one indexed point read for the HTML permalink status: is this film id a member (programme or watchlist) of the pinned published generation?
// Read-only; the caller treats any failure as "unknown", never as "absent".
export async function isMember(env,programmeRunId,filmId){
 const rows=await many(database(env),"SELECT 1 AS hit FROM published_epg_member WHERE programme_run_id=? AND kind IN ('programme','watchlist') AND film_id=? LIMIT 1",[programmeRunId,filmId]);
 return rows.length>0;
}
// AIR-531: the TMDB movie ids that members of a published run own through their trusted link, as a small map tmdbId -> set of member film ids. `published_epg_member` has no
// TMDB column (ADR 0142 decision 4), so it is built from the sealed programme and watchlist documents. Those documents are NOT fixed for a run: `saveWatchlist` and
// `patchProgramme` replace one of them in place and advance the publication generation. The map is therefore keyed by (database, run, generation) and the reads are fenced: the
// generation must still be the asked one after both documents are read, otherwise the read throws `published_epg_fence` (unknown, never an absence). The trust rule is the
// page's (`trustedMovieTmdb`): `tmdbId` is a positive integer and `tmdbLink` resolves to that very movie. Read-only; only the last key is kept.
let memberTmdbCache={db:null,run:null,generation:null,map:null};
export async function memberTmdbOwners(env,programmeRunId,generation){
 const db=database(env);
 if(memberTmdbCache.db===db&&memberTmdbCache.run===programmeRunId&&memberTmdbCache.generation===generation)return memberTmdbCache.map;
 const map=new Map();
 for(const kind of ['programme','watchlist']){
  const document=await readDocument(env,programmeRunId,kind);
  for(const film of Array.isArray(document?.films)?document.films:[]){
   const tmdb=film?.tmdbId==null?'':String(film.tmdbId),link=film?.tmdbLink;
   if(film?.id==null||!/^[1-9]\d{0,11}$/.test(tmdb)||link?.status!=='resolved'||link.link?.type!=='movie'||String(link.link.id)!==tmdb)continue;
   if(!map.has(tmdb))map.set(tmdb,new Set());
   map.get(tmdb).add(String(film.id));
  }
 }
 const closed=await currentGeneration(env);
 if(!closed||closed.programmeRunId!==programmeRunId||closed.generation!==generation)throw failed('published_epg_fence');
 memberTmdbCache={db,run:programmeRunId,generation,map};
 return map;
}
export async function readMembers(env,programmeRunId,kind){
 const rows=await many(database(env),'SELECT ordinal, film_id FROM published_epg_member WHERE programme_run_id=? AND kind=? ORDER BY ordinal',[programmeRunId,kind]);
 return rows.map(row=>({ordinal:Number(row.ordinal),filmId:row.film_id}));
}

async function chunkSha(chunk){
 return digest(chunk.map(item=>JSON.stringify(item.row)).join('\n'));
}
async function ensureClaim(db,stage,now,ttl,owner){
 const nonce=crypto.randomUUID();
 const expires=now+ttl;
 const insert=['INSERT INTO published_epg_stage (programme_run_id,target_programme_run_id,phase,payload_sha256,state,owner_token,claim_nonce,claim_generation,claim_expires_at,chunk_count,member_count,show_count,document_count,created_at,updated_at) VALUES (?,?,?,?,\'loading\',?,?,1,?,?,?,?,?,?,?)',[stage.id,stage.target,stage.phase,stage.sha,owner,nonce,expires,stage.chunks,stage.members,stage.shows,stage.documents,new Date(now).toISOString(),new Date(now).toISOString()]];
 try{await db.batch([db.prepare(insert[0]).bind(...insert[1])]);}
 catch(error){if(!/UNIQUE constraint failed/i.test(String(error?.message||error)))throw failed('published_epg_unavailable',error);}
 let row=await one(db,'SELECT state, owner_token AS owner, claim_nonce AS nonce, claim_generation AS generation, claim_expires_at AS expires, payload_sha256 AS sha, chunk_count AS chunks FROM published_epg_stage WHERE programme_run_id=?',[stage.id]);
 if(!row)throw failed('published_epg_unavailable');
 if(row.sha!==stage.sha||Number(row.chunks)!==stage.chunks)throw failed('published_epg_conflict');
 if(row.state==='published')return {nonce:row.nonce,generation:Number(row.generation),done:true};
 if(row.owner===owner&&row.nonce&&Number(row.expires)>now)return {nonce:row.nonce,generation:Number(row.generation),done:false};
 if(Number(row.expires)>now)throw failed('published_epg_lease');
 await fenced(db,[
  ['UPDATE published_epg_stage SET owner_token=?, claim_nonce=?, claim_generation=claim_generation+1, claim_expires_at=?, state=\'loading\', updated_at=? WHERE programme_run_id=? AND payload_sha256=? AND state IN (\'loading\',\'validated\') AND (claim_expires_at IS NULL OR claim_expires_at<=?)',[owner,nonce,expires,new Date(now).toISOString(),stage.id,stage.sha,now]],
  [FENCE_SQL,[]],
 ]);
 row=await one(db,'SELECT claim_nonce AS nonce, claim_generation AS generation, owner_token AS owner FROM published_epg_stage WHERE programme_run_id=?',[stage.id]);
 if(!row||row.nonce!==nonce||row.owner!==owner)throw failed('published_epg_lease');
 return {nonce,generation:Number(row.generation),done:false};
}
async function writeChunk(db,stage,chunk,index,claim,now,ttl){
 const sha=await chunkSha(chunk);
 const existing=await one(db,'SELECT content_sha256 AS sha FROM published_epg_stage_chunk WHERE programme_run_id=? AND chunk_index=?',[stage.id,index]);
 if(existing){if(existing.sha!==sha)throw failed('published_epg_conflict');return;}
 const expires=now+ttl;
 const statements=[
  ['UPDATE published_epg_stage SET claim_expires_at=?, updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state=\'loading\' AND claim_expires_at>?',[expires,new Date(now).toISOString(),stage.id,stage.owner,claim.nonce,claim.generation,now]],
  [FENCE_SQL,[]],
  ['INSERT INTO published_epg_stage_chunk (programme_run_id,chunk_index,content_sha256) VALUES (?,?,?)',[stage.id,index,sha]],
 ];
 chunk.forEach((item,ordinal)=>statements.push(statementFor(stage.id,index,ordinal,item.row)));
 await fenced(db,statements);
}
async function validate(db,stage,claim,now,ttl){
 const expires=now+ttl;
 await fenced(db,[
  [`UPDATE published_epg_stage SET state='validated', claim_expires_at=?, updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state IN ('loading','validated') AND claim_expires_at>? AND (SELECT COUNT(*) FROM published_epg_stage_chunk WHERE programme_run_id=?)=chunk_count AND (chunk_count=0 OR ((SELECT MIN(chunk_index) FROM published_epg_stage_chunk WHERE programme_run_id=?)=0 AND (SELECT MAX(chunk_index) FROM published_epg_stage_chunk WHERE programme_run_id=?)=chunk_count-1)) AND (SELECT COUNT(*) FROM published_epg_stage_row WHERE programme_run_id=? AND kind='member')=member_count AND (SELECT COUNT(*) FROM published_epg_stage_row WHERE programme_run_id=? AND kind='show')=show_count AND (SELECT COUNT(*) FROM published_epg_stage_row WHERE programme_run_id=? AND kind='document')=document_count`,[expires,new Date(now).toISOString(),stage.id,stage.owner,claim.nonce,claim.generation,now,stage.id,stage.id,stage.id,stage.id,stage.id,stage.id]],
  [FENCE_SQL,[]],
 ]);
}
function copyStatements(target,stageId){
 return [
  ['INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) SELECT ?,doc_kind,item_ordinal,payload_json FROM published_epg_stage_row WHERE programme_run_id=? AND kind=\'document\'',[target,stageId]],
  ['INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) SELECT ?,doc_kind,item_ordinal,film_id FROM published_epg_stage_row WHERE programme_run_id=? AND kind=\'member\'',[target,stageId]],
  ['INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) SELECT ?,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason FROM published_epg_stage_row WHERE programme_run_id=? AND kind=\'show\'',[target,stageId]],
 ];
}
function claimStillHeld(stage,claim,now,ttl){
 const stamp=new Date(now).toISOString();
 return ['UPDATE published_epg_stage SET claim_expires_at=?, updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state=\'validated\' AND claim_expires_at>?',[now+ttl,stamp,stage.id,stage.owner,claim.nonce,claim.generation,now]];
}
// ADR 0135 (AIR-459). With `discovery_epg_priority` absent (migration 0022 not applied) the pointer statement is byte for byte today's. With it present, the same
// UPDATE that moves `programme_run_id` also writes `madrid_run_key` (the sync run's frozen day; NULL when it has none), and the same batch clears the pause row when the
// Discovery pin already names this run and the stamped day is the owed or overridden date. The batch never writes the pin. If the pin is behind, the row stays `paused`
// and a later batch (the replay branch below, or the next Discovery acquire) clears it once both name the run.
const PAUSE_CLEAR_SQL="UPDATE discovery_epg_priority SET state='clear', owed_day_key=NULL, override_day_key=NULL WHERE id=1 AND (state<>'clear' OR override_day_key IS NOT NULL) AND EXISTS (SELECT 1 FROM published_epg_authority e, discovery_authority a WHERE e.id=1 AND a.id=1 AND e.programme_run_id=? AND a.published_programme_run_id=e.programme_run_id AND e.madrid_run_key IS NOT NULL AND (e.madrid_run_key=discovery_epg_priority.owed_day_key OR e.madrid_run_key=discovery_epg_priority.override_day_key))";
async function pausePresent(db){
 const row=await one(db,"SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='discovery_epg_priority'");
 return !!row;
}
async function commitPublish(db,stage,claim,authority,expected,now,ttl){
 const stamp=new Date(now).toISOString();
 const generation=stage.expectedGeneration??authority.generation;
 const paused=stage.phase==='published'&&stage.pausePresent===true;
 const move=stage.phase==='published'
  ?paused
   ?['UPDATE published_epg_authority SET programme_run_id=?, generation=generation+1, watchlist_generation=watchlist_generation+1, madrid_run_key=? WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND programme_run_id IS ?',[stage.target,stage.madridRunKey??null,generation,expected]]
   :['UPDATE published_epg_authority SET programme_run_id=?, generation=generation+1, watchlist_generation=watchlist_generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND programme_run_id IS ?',[stage.target,generation,expected]]
  :['UPDATE published_epg_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=?',[generation]];
 await fenced(db,[
  ...epgFenceStatements(stage.epgFence),
  claimStillHeld(stage,claim,now,ttl),
  [FENCE_SQL,[]],
  move,
  [FENCE_SQL,[]],
  ...(paused?[[PAUSE_CLEAR_SQL,[stage.target]]]:[]),
  ['INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES (?,?,?,?,?)',[stage.target,stage.phase,stage.publishedAt,stage.sha,stamp]],
  ...copyStatements(stage.target,stage.id),
  ['UPDATE published_epg_stage SET state=\'published\', updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state=\'validated\'',[stamp,stage.id,stage.owner,claim.nonce,claim.generation]],
  [FENCE_SQL,[]],
 ]);
}
async function commitReplace(db,stage,claim,authority,kind,now,ttl){
 const stamp=new Date(now).toISOString();
 const generation=stage.expectedGeneration??authority.generation;
 const clears=kind==='watchlist'
  ?[
   ['DELETE FROM published_epg_document WHERE programme_run_id=? AND kind=\'watchlist\'',[stage.target]],
   ['DELETE FROM published_epg_member WHERE programme_run_id=? AND kind=\'watchlist\'',[stage.target]],
  ]
  :[
   ['DELETE FROM published_epg_document WHERE programme_run_id=? AND kind=\'programme\'',[stage.target]],
   ['DELETE FROM published_epg_member WHERE programme_run_id=? AND kind=\'programme\'',[stage.target]],
   ['DELETE FROM published_epg_show WHERE programme_run_id=?',[stage.target]],
  ];
 await fenced(db,[
  ...epgFenceStatements(stage.epgFence),
  claimStillHeld(stage,claim,now,ttl),
  [FENCE_SQL,[]],
  ['UPDATE published_epg_authority SET generation=generation+1, watchlist_generation=CASE WHEN ?=\'watchlist\' THEN watchlist_generation+1 ELSE watchlist_generation END WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND generation=? AND programme_run_id=?',[kind,generation,stage.target]],
  [FENCE_SQL,[]],
  ...clears,
  ...copyStatements(stage.target,stage.id),
  ['UPDATE published_epg_generation SET payload_sha256=? WHERE programme_run_id=?',[stage.sha,stage.target]],
  ['UPDATE published_epg_stage SET state=\'published\', updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state=\'validated\'',[stamp,stage.id,stage.owner,claim.nonce,claim.generation]],
  [FENCE_SQL,[]],
 ]);
}
async function stageCommit(db,spec,options){
 const now=Number.isFinite(options.now)?options.now:Date.now();
 const ttl=Number.isFinite(options.claimTtlMs)?options.claimTtlMs:CLAIM_TTL_MS;
 if(ttl<1000||ttl>60*60*1000)throw failed('published_epg_lease');
 const owner=options.owner||crypto.randomUUID();
 const authority=await readAuthority(db);
 if(authority.mode!=='d1'||!authority.tables)throw failed('published_epg_not_authoritative');
 if(spec.expectedGeneration!=null&&authority.generation!==spec.expectedGeneration)throw failed('published_epg_fence');
 const rows=[
  ...spec.logical.members.map(member=>({kind:'member',memberKind:member.kind,ordinal:member.ordinal,filmId:member.filmId})),
  ...spec.logical.shows.map(show=>({kind:'show',...show})),
  ...spec.logical.documents,
 ];
 const chunks=pack(spec.stageId,rows,options.chunkStatements||CHUNK_STATEMENTS,options.chunkBytes||CHUNK_BYTES);
 const stage={id:spec.stageId,target:spec.target,phase:spec.phase,sha:spec.sha,publishedAt:spec.publishedAt??null,chunks:chunks.length,members:spec.logical.members.length,shows:spec.logical.shows.length,documents:spec.logical.documents.length,owner,expectedGeneration:spec.expectedGeneration??null,madridRunKey:spec.madridRunKey??null,pausePresent:spec.phase==='published'?await pausePresent(db):false};
 const claim=await ensureClaim(db,stage,now,ttl,owner);
 if(!claim.done){
  for(let index=0;index<chunks.length;index++)await writeChunk(db,{...stage,owner},chunks[index],index,claim,now,ttl);
  await validate(db,{...stage,owner},claim,now,ttl);
  if(typeof options.afterValidate==='function')await options.afterValidate({db,stage:{...stage,owner},claim,now});
  try{
   if(spec.replace)await commitReplace(db,{...stage,owner,epgFence:options.epgFence??null},claim,authority,spec.replace,now,ttl);
   else await commitPublish(db,{...stage,owner,epgFence:options.epgFence??null},claim,authority,spec.expected,now,ttl);
  }catch(error){
   if(error?.code==='published_epg_fence'){
    const committed=await one(db,'SELECT 1 AS ok FROM published_epg_generation WHERE programme_run_id=?',[spec.replace?spec.stageId:stage.target]);
    const held=await one(db,'SELECT owner_token AS owner, claim_nonce AS nonce FROM published_epg_stage WHERE programme_run_id=?',[stage.id]);
    if(!committed&&held&&held.owner===owner&&held.nonce===claim.nonce)await db.batch([
     db.prepare('DELETE FROM published_epg_stage_row WHERE programme_run_id=?').bind(stage.id),
     db.prepare('DELETE FROM published_epg_stage_chunk WHERE programme_run_id=?').bind(stage.id),
     db.prepare('DELETE FROM published_epg_stage WHERE programme_run_id=?').bind(stage.id),
    ]).catch(()=>{});
   }
   throw error;
  }
 }
 return readAuthority(db);
}

export async function publishGeneration(env,input,options={}){
 if(options.epgFence===undefined&&env?.epgFence!==undefined)options={...options,epgFence:env.epgFence};
 const db=database(env);
 const opened=await readAuthority(db);
 if(opened.mode!=='d1'||opened.cutover!=='open')throw failed('published_epg_not_authoritative');
 const programmeRunId=input?.programmeRunId==null?'':String(input.programmeRunId);
 if(!programmeRunId)throw failed('published_epg_programme');
 const phase=input.phase==='withheld'?'withheld':input.phase==='published'?'published':null;
 if(!phase)throw failed('published_epg_phase');
 if(phase==='published'&&!Object.prototype.hasOwnProperty.call(input,'expectedProgrammeRunId'))throw failed('published_epg_expected');
 const programme=input.programme;
 const watchlist=input.watchlist??{films:[]};
 const programmeText=JSON.stringify(programme);
 const watchlistText=JSON.stringify(watchlist);
 const sha=await digest(phase+'\n'+programmeText+'\n'+watchlistText);
 const existing=await one(db,'SELECT phase, payload_sha256 AS sha FROM published_epg_generation WHERE programme_run_id=?',[programmeRunId]);
 if(existing){
  if(existing.phase!==phase||existing.sha!==sha)throw failed('published_epg_conflict');
  const authority=await readAuthority(db);
  // ADR 0135: a repeated pointer publication is the replay branch, not a second publish. It may still clear a pause the first batch could not (pin behind then).
  if(phase==='published'&&authority.programmeRunId===programmeRunId&&await pausePresent(db))await db.batch([db.prepare(PAUSE_CLEAR_SQL).bind(programmeRunId)]);
  return {programmeRunId,phase,replay:true,pointed:authority.programmeRunId===programmeRunId,authoritative:true};
 }
 const logical=logicalRows(programme,watchlist,programmeText,watchlistText);
 const authority=await stageCommit(db,{stageId:programmeRunId,target:programmeRunId,phase,sha,publishedAt:input.publishedAt??programme?.updatedAt??null,expected:input.expectedProgrammeRunId??null,madridRunKey:/^\d{4}-\d{2}-\d{2}$/.test(input.madridRunKey||'')?input.madridRunKey:null,logical},options);
 if(phase==='published'&&authority.programmeRunId!==programmeRunId)throw failed('published_epg_fence');
 return {programmeRunId,phase,replay:false,pointed:phase==='published',authoritative:true,generation:authority.generation};
}

async function replacePart(env,target,kind,programme,watchlist,options){
 if(options.epgFence===undefined&&env?.epgFence!==undefined)options={...options,epgFence:env.epgFence};
 const db=database(env);
 const authority=await readAuthority(env);
 const current=await currentGeneration(env);
 if(!current)return null;
 if(!current.programmeRunId||current.programmeRunId!==target)return false;
 const expectedGeneration=Number.isInteger(options.expectedGeneration)?options.expectedGeneration:current.generation;
 if(current.generation!==expectedGeneration)return false;
 const storedProgramme=kind==='programme'?programme:await readDocument(env,target,'programme');
 const storedWatchlist=kind==='watchlist'?watchlist:await readDocument(env,target,'watchlist');
 if(!storedProgramme||!storedWatchlist)throw failed('published_epg_unavailable');
 const stageId=target+'#'+kind+'#'+expectedGeneration;
 const programmeText=JSON.stringify(storedProgramme);
 const watchlistText=JSON.stringify(storedWatchlist);
 const generation=await one(db,'SELECT phase FROM published_epg_generation WHERE programme_run_id=?',[target]);
 if(!generation)throw failed('published_epg_unavailable');
 const sha=await digest(generation.phase+'\n'+programmeText+'\n'+watchlistText);
 const logical=logicalRows(storedProgramme,storedWatchlist,programmeText,watchlistText);
 if(kind==='watchlist'){logical.members=logical.members.filter(member=>member.kind==='watchlist');logical.shows=[];logical.documents=logical.documents.filter(row=>row.docKind==='watchlist');}
 else{logical.members=logical.members.filter(member=>member.kind==='programme');logical.documents=logical.documents.filter(row=>row.docKind==='programme');}
 try{
  await stageCommit(db,{stageId,target,phase:generation.phase,sha,publishedAt:null,replace:kind,expectedGeneration,logical},{...options,owner:options.owner||crypto.randomUUID()});
 }catch(error){
  if(error?.code==='published_epg_fence'||error?.code==='published_epg_lease')return false;
  throw error;
 }
 const after=await currentGeneration(env);
 if(!after||after.generation!==expectedGeneration+1||after.programmeRunId!==target)return false;
 const body=kind==='watchlist'?storedWatchlist:storedProgramme;
 const key=kind==='watchlist'?WATCHLIST_KEY:PROGRAMME_KEY;
 if(env.BUCKET&&typeof env.BUCKET.put==='function'&&typeof env.BUCKET.get==='function'){
  try{
   await putStable(env.BUCKET,key,body);
   await putStable(env.BUCKET,generationObjectKey(target,key),body);
  }catch{/* The D1 commit stands. A later read repairs the mirror. */}
 }
 return true;
}
export async function patchProgramme(env,programmeRunId,programme,options={}){
 if(!programme||!Array.isArray(programme.films))throw failed('published_epg_programme');
 return replacePart(env,programmeRunId,'programme',programme,null,options);
}
export async function saveWatchlist(env,watchlist,options={}){
 const authority=await readAuthority(env);
 const current=await currentGeneration(env);
 if(!current)return null;
 if(!watchlist||!Array.isArray(watchlist.films))throw failed('published_epg_watchlist');
 if(!current.programmeRunId)return false;
 return replacePart(env,current.programmeRunId,'watchlist',null,watchlist,options);
}

const JSON_PUT={httpMetadata:{contentType:'application/json'}};
async function objectText(object){
 if(!object)return null;
 if(typeof object.text==='function')return object.text();
 return JSON.stringify(await object.json());
}
async function putStable(bucket,key,value){
 const text=JSON.stringify(value);
 const current=await bucket.get(key);
 if(current){
  if(await objectText(current)===text)return current.etag??null;
  if(!current.etag)return null;
  const saved=await bucket.put(key,text,{...JSON_PUT,onlyIf:{etagMatches:current.etag}});
  return saved?.etag??null;
 }
 const saved=await bucket.put(key,text,{...JSON_PUT,onlyIf:{etagDoesNotMatch:'*'}});
 return saved?.etag??null;
}
async function mirrorObject(bucket,key,value){
 const object=await bucket.get(key);
 if(!object)return {match:false,etag:null};
 const text=await objectText(object);
 return {match:text===JSON.stringify(value),etag:object.etag??null};
}
export async function writeMirrors(env,input){
 const db=database(env);
 const authority=await readAuthority(db);
 if(!authority.ready||authority.programmeRunId!==input.programmeRunId)return false;
 const bucket=env.BUCKET;
 if(!bucket||typeof bucket.put!=='function'||typeof bucket.get!=='function')return false;
 try{
  const programmeCopy=await putStable(bucket,generationObjectKey(input.programmeRunId,'programme.json'),input.programme);
  const rootProgramme=await putStable(bucket,PROGRAMME_KEY,input.programme);
  if(!programmeCopy||!rootProgramme)return false;
  let watchlistEtag=null;
  if(input.watchlist){
   watchlistEtag=await putStable(bucket,WATCHLIST_KEY,input.watchlist);
   const watchlistCopy=await putStable(bucket,generationObjectKey(input.programmeRunId,'watchlist.json'),input.watchlist);
   if(!watchlistEtag||!watchlistCopy)return false;
  }
  let pointerEtag=authority.mirrorEtag;
  if(input.phase!=='withheld'){
   pointerEtag=await putStable(bucket,POINTER_KEY,{programmeRunId:input.programmeRunId,phase:'published'});
  }
  if(!pointerEtag)return false;
  await fenced(db,[
   ['UPDATE published_epg_authority SET mirror_programme_run_id=?, mirror_etag=?, mirror_watchlist_etag=COALESCE(?, mirror_watchlist_etag) WHERE id=1 AND mode=\'d1\' AND cutover=\'open\' AND programme_run_id=? AND generation=?',[input.programmeRunId,pointerEtag,watchlistEtag,input.programmeRunId,authority.generation]],
   [FENCE_SQL,[]],
  ]);
  const after=await readAuthority(db);
  return after.mirrorProgrammeRunId===input.programmeRunId&&after.mirrorEtag===pointerEtag&&(watchlistEtag==null||after.mirrorWatchlistEtag===watchlistEtag);
 }catch{return false;}
}
export async function repairMirrors(env){
 const authority=await readAuthority(env);
 const current=await currentGeneration(env);
 if(!current?.programmeRunId)return current?{mirrored:false,aligned:false,wrote:false,authority:current}:{mirrored:false,aligned:false,wrote:false};
 const bucket=env?.BUCKET;
 if(!bucket||typeof bucket.get!=='function')return {mirrored:false,aligned:false,wrote:false,authority:current};
 const programme=await readCompletedProgramme(env,current.programmeRunId);
 const watchlist=await readDocument(env,current.programmeRunId,'watchlist');
 if(!programme||!watchlist)return {mirrored:false,aligned:false,wrote:false,authority:current};
 const run=current.programmeRunId;
 const pointer=await mirrorObject(bucket,POINTER_KEY,{programmeRunId:run,phase:'published'});
 const programmeMirror=await mirrorObject(bucket,PROGRAMME_KEY,programme);
 const watchlistMirror=await mirrorObject(bucket,WATCHLIST_KEY,watchlist);
 const programmeCopy=await mirrorObject(bucket,generationObjectKey(run,'programme.json'),programme);
 const watchlistCopy=await mirrorObject(bucket,generationObjectKey(run,'watchlist.json'),watchlist);
 const aligned=pointer.match&&pointer.etag===current.mirrorEtag&&programmeMirror.match&&watchlistMirror.match&&watchlistMirror.etag===current.mirrorWatchlistEtag&&programmeCopy.match&&watchlistCopy.match;
 if(aligned)return {mirrored:true,aligned:true,wrote:false,authority:current};
 const mirrored=await writeMirrors(env,{programmeRunId:run,programme,watchlist,phase:'published'});
 return {mirrored,aligned:false,wrote:!!mirrored,authority:await readAuthority(env)};
}

export async function authoritativeSnapshot(env){
 const current=await currentGeneration(env);
 if(!current)return null;
 if(!current.programmeRunId)return {programmeRunId:null,programme:null,watchlist:null,generation:current.generation};
 const programme=await readCompletedProgramme(env,current.programmeRunId);
 const watchlist=await readDocument(env,current.programmeRunId,'watchlist');
 const after=await currentGeneration(env);
 if(!after||after.generation!==current.generation||after.programmeRunId!==current.programmeRunId)throw failed('published_epg_fence');
 return {programmeRunId:current.programmeRunId,programme,watchlist,generation:current.generation};
}
