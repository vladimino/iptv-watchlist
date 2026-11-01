// ADR 0079. The published programme generation, its pointer, show rows and
// watchlist membership. The nine tables plus the marker are the authority.
// 0008 runs only after the prediction contract is version 7, and it leaves
// version 8. A missing table at version 8, a published table below version 8,
// or a marker other than r2 or d1 fails closed. A missing binding fails closed,
// and so does a bound database with no schema_contract, unless the caller sets
// PUBLISHED_EPG_DB_OPTIONAL to standin. Mode d1 reads
// and writes these tables and does not fall back to a different R2 generation.
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
 let version;
 try{version=(await one(target,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error))&&db?.PUBLISHED_EPG_DB_OPTIONAL==='standin')return {mode:'r2',tables:false,version:null,ready:false};
  throw failed('published_epg_unavailable',error);
 }
 let names;
 try{names=(await many(target,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'published_epg%'")).map(row=>row.name);}
 catch(error){throw failed('published_epg_unavailable',error);}
 const tables=TABLES.every(name=>names.includes(name));
 if(!tables){
  const numeric=Number(version);
  if(version==null||!Number.isFinite(numeric)){
   if(db?.PUBLISHED_EPG_DB_OPTIONAL==='standin')return {mode:'r2',tables:false,version:null,ready:false};
   throw failed('published_epg_unavailable');
  }
  if(numeric>=8)throw failed('published_epg_unavailable');
  return {mode:'r2',tables:false,version:numeric,ready:false};
 }
 if(!(Number(version)>=8))throw failed('published_epg_unavailable');
 let row;
 try{row=await one(target,'SELECT mode, programme_run_id AS programmeRunId, generation, mirror_programme_run_id AS mirrorProgrammeRunId, mirror_etag AS mirrorEtag, watchlist_generation AS watchlistGeneration, mirror_watchlist_etag AS mirrorWatchlistEtag FROM published_epg_authority WHERE id=1');}
 catch(error){throw failed('published_epg_unavailable',error);}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1'))throw failed('published_epg_unavailable');
 return {mode:row.mode,tables:true,version:Number(version),ready:row.mode==='d1',programmeRunId:row.programmeRunId??null,generation:Number(row.generation),mirrorProgrammeRunId:row.mirrorProgrammeRunId??null,mirrorEtag:row.mirrorEtag??null,watchlistGeneration:Number(row.watchlistGeneration),mirrorWatchlistEtag:row.mirrorWatchlistEtag??null};
}

export async function currentGeneration(env){
 const authority=await readAuthority(env);
 if(authority.mode!=='d1')return null;
 const programmeRunId=authority.programmeRunId;
 return {authority:'d1',programmeRunId,phase:programmeRunId?'published':null,generation:authority.generation,fence:'d1:'+authority.generation+':'+(programmeRunId||''),mirrorProgrammeRunId:authority.mirrorProgrammeRunId,mirrorEtag:authority.mirrorEtag,watchlistGeneration:authority.watchlistGeneration};
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
export async function readDocumentAt(env,programmeRunId,kind,generation){
 const opened=await currentGeneration(env);
 if(!opened||opened.programmeRunId!==programmeRunId||opened.generation!==generation)throw failed('published_epg_fence');
 const document=await readDocument(env,programmeRunId,kind);
 const closed=await currentGeneration(env);
 if(!closed||closed.generation!==generation||closed.programmeRunId!==programmeRunId)throw failed('published_epg_fence');
 return document;
}
export async function readShows(env,programmeRunId){
 const rows=await many(database(env),'SELECT film_id, channel_id, channel, start_ms, end_ms, epg_title, basis, match_reason FROM published_epg_show WHERE programme_run_id=? ORDER BY film_id, start_ms, channel_id',[programmeRunId]);
 return rows.map(row=>({filmId:row.film_id,channelId:row.channel_id,channel:row.channel??null,startMs:Number(row.start_ms),endMs:row.end_ms==null?null:Number(row.end_ms),epgTitle:row.epg_title??null,basis:row.basis??null,matchReason:row.match_reason??null}));
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
async function commitPublish(db,stage,claim,authority,expected,now,ttl){
 const stamp=new Date(now).toISOString();
 const generation=stage.expectedGeneration??authority.generation;
 const move=stage.phase==='published'
  ?['UPDATE published_epg_authority SET programme_run_id=?, generation=generation+1, watchlist_generation=watchlist_generation+1 WHERE id=1 AND mode=\'d1\' AND generation=? AND programme_run_id IS ?',[stage.target,generation,expected]]
  :['UPDATE published_epg_authority SET generation=generation+1 WHERE id=1 AND mode=\'d1\' AND generation=?',[generation]];
 await fenced(db,[
  claimStillHeld(stage,claim,now,ttl),
  [FENCE_SQL,[]],
  move,
  [FENCE_SQL,[]],
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
  claimStillHeld(stage,claim,now,ttl),
  [FENCE_SQL,[]],
  ['UPDATE published_epg_authority SET generation=generation+1, watchlist_generation=CASE WHEN ?=\'watchlist\' THEN watchlist_generation+1 ELSE watchlist_generation END WHERE id=1 AND mode=\'d1\' AND generation=? AND programme_run_id=?',[kind,generation,stage.target]],
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
 const stage={id:spec.stageId,target:spec.target,phase:spec.phase,sha:spec.sha,publishedAt:spec.publishedAt??null,chunks:chunks.length,members:spec.logical.members.length,shows:spec.logical.shows.length,documents:spec.logical.documents.length,owner,expectedGeneration:spec.expectedGeneration??null};
 const claim=await ensureClaim(db,stage,now,ttl,owner);
 if(!claim.done){
  for(let index=0;index<chunks.length;index++)await writeChunk(db,{...stage,owner},chunks[index],index,claim,now,ttl);
  await validate(db,{...stage,owner},claim,now,ttl);
  if(typeof options.afterValidate==='function')await options.afterValidate({db,stage:{...stage,owner},claim,now});
  try{
   if(spec.replace)await commitReplace(db,{...stage,owner},claim,authority,spec.replace,now,ttl);
   else await commitPublish(db,{...stage,owner},claim,authority,spec.expected,now,ttl);
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
 const db=database(env);
 const opened=await readAuthority(db);
 if(opened.mode!=='d1')throw failed('published_epg_not_authoritative');
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
  return {programmeRunId,phase,replay:true,pointed:authority.programmeRunId===programmeRunId,authoritative:true};
 }
 const logical=logicalRows(programme,watchlist,programmeText,watchlistText);
 const authority=await stageCommit(db,{stageId:programmeRunId,target:programmeRunId,phase,sha,publishedAt:input.publishedAt??programme?.updatedAt??null,expected:input.expectedProgrammeRunId??null,logical},options);
 if(phase==='published'&&authority.programmeRunId!==programmeRunId)throw failed('published_epg_fence');
 return {programmeRunId,phase,replay:false,pointed:phase==='published',authoritative:true,generation:authority.generation};
}

async function replacePart(env,target,kind,programme,watchlist,options){
 const db=database(env);
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
 if(authority.mode!=='d1'||authority.programmeRunId!==input.programmeRunId)return false;
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
   ['UPDATE published_epg_authority SET mirror_programme_run_id=?, mirror_etag=?, mirror_watchlist_etag=COALESCE(?, mirror_watchlist_etag) WHERE id=1 AND mode=\'d1\' AND programme_run_id=? AND generation=?',[input.programmeRunId,pointerEtag,watchlistEtag,input.programmeRunId,authority.generation]],
   [FENCE_SQL,[]],
  ]);
  const after=await readAuthority(db);
  return after.mirrorProgrammeRunId===input.programmeRunId&&after.mirrorEtag===pointerEtag&&(watchlistEtag==null||after.mirrorWatchlistEtag===watchlistEtag);
 }catch{return false;}
}
export async function repairMirrors(env){
 const current=await currentGeneration(env);
 if(!current?.programmeRunId)return current?{mirrored:false,authority:current}:{mirrored:false};
 const bucket=env?.BUCKET;
 if(!bucket||typeof bucket.get!=='function')return {mirrored:false,authority:current};
 const programme=await readDocument(env,current.programmeRunId,'programme');
 const watchlist=await readDocument(env,current.programmeRunId,'watchlist');
 if(!programme||!watchlist)return {mirrored:false,authority:current};
 const run=current.programmeRunId;
 const pointer=await mirrorObject(bucket,POINTER_KEY,{programmeRunId:run,phase:'published'});
 const programmeMirror=await mirrorObject(bucket,PROGRAMME_KEY,programme);
 const watchlistMirror=await mirrorObject(bucket,WATCHLIST_KEY,watchlist);
 const programmeCopy=await mirrorObject(bucket,generationObjectKey(run,'programme.json'),programme);
 const watchlistCopy=await mirrorObject(bucket,generationObjectKey(run,'watchlist.json'),watchlist);
 const aligned=pointer.match&&pointer.etag===current.mirrorEtag&&programmeMirror.match&&watchlistMirror.match&&watchlistMirror.etag===current.mirrorWatchlistEtag&&programmeCopy.match&&watchlistCopy.match;
 if(aligned)return {mirrored:true,authority:current};
 const mirrored=await writeMirrors(env,{programmeRunId:run,programme,watchlist,phase:'published'});
 return {mirrored,authority:await readAuthority(env)};
}

export async function authoritativeSnapshot(env){
 const current=await currentGeneration(env);
 if(!current)return null;
 if(!current.programmeRunId)return {programmeRunId:null,programme:null,watchlist:null,generation:current.generation};
 const programme=await readDocument(env,current.programmeRunId,'programme');
 const watchlist=await readDocument(env,current.programmeRunId,'watchlist');
 const after=await currentGeneration(env);
 if(!after||after.generation!==current.generation||after.programmeRunId!==current.programmeRunId)throw failed('published_epg_fence');
 return {programmeRunId:current.programmeRunId,programme,watchlist,generation:current.generation};
}

async function objectJson(bucket,key){
 const object=await bucket.get(key);
 if(!object)throw failed('published_epg_unavailable');
 let value;
 try{value=await object.json();}catch{throw failed('published_epg_programme');}
 return {value,etag:object.etag??null};
}
export async function importPublished(env,{confirm,programme,watchlist,programmeRunId,publishedAt,pointerEtag,watchlistEtag}={}){
 if(confirm!=='load')throw failed('published_epg_confirm');
 const db=database(env);
 const authority=await readAuthority(db);
 if(!(Number(authority.version)>=8)||!authority.tables)throw failed('published_epg_schema');
 if(authority.mode!=='r2')throw failed('published_epg_authoritative');
 const runId=programmeRunId==null?'':String(programmeRunId);
 if(!runId||!programme||!watchlist)throw failed('published_epg_programme');
 const programmeText=JSON.stringify(programme);
 const watchlistText=JSON.stringify(watchlist);
 const sha=await digest('published\n'+programmeText+'\n'+watchlistText);
 const logical=logicalRows(programme,watchlist,programmeText,watchlistText);
 const options={};
 const now=Date.now();
 const owner=crypto.randomUUID();
 const rows=[...logical.members.map(member=>({kind:'member',memberKind:member.kind,ordinal:member.ordinal,filmId:member.filmId})),...logical.shows.map(show=>({kind:'show',...show})),...logical.documents];
 const chunks=pack(runId,rows,CHUNK_STATEMENTS,CHUNK_BYTES);
 const stage={id:runId,target:runId,phase:'published',sha,publishedAt:publishedAt??programme.updatedAt??null,chunks:chunks.length,members:logical.members.length,shows:logical.shows.length,documents:logical.documents.length,owner};
 const claim=await ensureClaim(db,stage,now,CLAIM_TTL_MS,owner);
 if(!claim.done){
  for(let index=0;index<chunks.length;index++)await writeChunk(db,{...stage,owner},chunks[index],index,claim,now,CLAIM_TTL_MS);
  await validate(db,{...stage,owner},claim,now,CLAIM_TTL_MS);
  const stamp=new Date(now).toISOString();
  await fenced(db,[
   claimStillHeld({...stage,owner},claim,now,CLAIM_TTL_MS),
   [FENCE_SQL,[]],
   ['UPDATE published_epg_authority SET programme_run_id=?, generation=generation+1, mirror_programme_run_id=?, mirror_etag=?, watchlist_generation=watchlist_generation+1, mirror_watchlist_etag=? WHERE id=1 AND mode=\'r2\' AND generation=?',[runId,runId,pointerEtag??null,watchlistEtag??null,authority.generation]],
   [FENCE_SQL,[]],
   ['INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES (?,?,?,?,?)',[runId,'published',stage.publishedAt,sha,stamp]],
   ...copyStatements(runId,runId),
   ['UPDATE published_epg_stage SET state=\'published\', updated_at=? WHERE programme_run_id=? AND owner_token=? AND claim_nonce=? AND claim_generation=? AND state=\'validated\'',[stamp,runId,owner,claim.nonce,claim.generation]],
   [FENCE_SQL,[]],
  ]);
 }
 const stored=await readDocument(db,runId,'programme');
 const listed=await readDocument(db,runId,'watchlist');
 if(JSON.stringify(stored)!==programmeText||JSON.stringify(listed)!==watchlistText)throw failed('published_epg_loss');
 const after=await readAuthority(db);
 if(after.mode!=='r2'||after.programmeRunId!==runId)throw failed('published_epg_loss');
 return after;
}
function sameMembership(films,members){
 const ids=(Array.isArray(films)?films:[]).map(film=>String(film?.id??''));
 return ids.length===members.length&&ids.every((id,index)=>id===members[index].filmId);
}
async function activationSnapshot(env,fallback){
 if(env.BUCKET&&typeof env.BUCKET.get==='function'){
  const pointer=await objectJson(env.BUCKET,POINTER_KEY);
  const programme=await objectJson(env.BUCKET,PROGRAMME_KEY);
  const watchlist=await objectJson(env.BUCKET,WATCHLIST_KEY);
  if(pointer.value?.phase!=='published'||typeof pointer.value.programmeRunId!=='string')throw failed('published_epg_fence');
  return {programmeRunId:pointer.value.programmeRunId,pointerEtag:pointer.etag,watchlistEtag:watchlist.etag,programme:programme.value,watchlist:watchlist.value};
 }
 if(!fallback?.programme||!fallback?.watchlist||!fallback.pointerEtag||!fallback.watchlistEtag)throw failed('published_epg_fence');
 return {programmeRunId:fallback.programmeRunId,pointerEtag:fallback.pointerEtag,watchlistEtag:fallback.watchlistEtag,programme:fallback.programme,watchlist:fallback.watchlist};
}
export async function activatePublished(env,{confirm,pointerEtag,watchlistEtag,programme,watchlist}={}){
 if(confirm!=='activate')throw failed('published_epg_confirm');
 const db=database(env);
 const authority=await readAuthority(db);
 if(!(Number(authority.version)>=8)||!authority.tables)throw failed('published_epg_schema');
 if(authority.mode!=='r2')throw failed('published_epg_authoritative');
 if(!authority.programmeRunId||authority.mirrorProgrammeRunId!==authority.programmeRunId||!authority.mirrorEtag||!authority.mirrorWatchlistEtag)throw failed('published_epg_fence');
 const storedProgramme=await readDocument(db,authority.programmeRunId,'programme');
 const storedWatchlist=await readDocument(db,authority.programmeRunId,'watchlist');
 if(!storedProgramme||!storedWatchlist)throw failed('published_epg_loss');
 const live=await activationSnapshot(env,{programmeRunId:authority.programmeRunId,pointerEtag,watchlistEtag,programme,watchlist});
 if(live.programmeRunId!==authority.programmeRunId||live.pointerEtag!==authority.mirrorEtag||live.pointerEtag!==pointerEtag||live.watchlistEtag!==authority.mirrorWatchlistEtag)throw failed('published_epg_fence');
 if(JSON.stringify(live.programme)!==JSON.stringify(storedProgramme)||JSON.stringify(live.watchlist)!==JSON.stringify(storedWatchlist))throw failed('published_epg_fence');
 const programmeMembers=await readMembers(db,authority.programmeRunId,'programme');
 const watchMembers=await readMembers(db,authority.programmeRunId,'watchlist');
 if(!sameMembership(live.programme?.films,programmeMembers)||!sameMembership(live.watchlist?.films,watchMembers))throw failed('published_epg_fence');
 await fenced(db,[
  ['UPDATE published_epg_authority SET mode=\'d1\' WHERE id=1 AND mode=\'r2\' AND programme_run_id=? AND mirror_programme_run_id=? AND mirror_etag=? AND mirror_watchlist_etag=? AND generation=?',[authority.programmeRunId,authority.mirrorProgrammeRunId,authority.mirrorEtag,authority.mirrorWatchlistEtag,authority.generation]],
  [FENCE_SQL,[]],
 ]);
 const after=await readAuthority(db);
 if(after.mode!=='d1'||after.programmeRunId!==authority.programmeRunId)throw failed('published_epg_fence');
 return after;
}
export async function revertPublished(env,{confirm}={}){
 if(confirm!=='r2')throw failed('published_epg_confirm');
 let authority=await readAuthority(env);
 if(!(Number(authority.version)>=8)||!authority.tables)throw failed('published_epg_schema');
 if(authority.mode!=='d1')throw failed('published_epg_not_authoritative');
 const repaired=await repairMirrors(env);
 if(!repaired.mirrored)throw failed('published_epg_fence');
 authority=await readAuthority(env);
 const pointer=await objectJson(env.BUCKET,POINTER_KEY);
 const programmeMirror=await objectJson(env.BUCKET,PROGRAMME_KEY);
 const watchlistMirror=await objectJson(env.BUCKET,WATCHLIST_KEY);
 const programme=await readDocument(env,authority.programmeRunId,'programme');
 const watchlist=await readDocument(env,authority.programmeRunId,'watchlist');
 if(pointer.value?.programmeRunId!==authority.programmeRunId||pointer.etag!==authority.mirrorEtag)throw failed('published_epg_fence');
 if(!watchlist||watchlistMirror.etag!==authority.mirrorWatchlistEtag)throw failed('published_epg_fence');
 if(JSON.stringify(programmeMirror.value)!==JSON.stringify(programme)||JSON.stringify(watchlistMirror.value)!==JSON.stringify(watchlist))throw failed('published_epg_fence');
 const programmeMembers=await readMembers(env,authority.programmeRunId,'programme');
 const watchMembers=await readMembers(env,authority.programmeRunId,'watchlist');
 if(!sameMembership(programme?.films,programmeMembers)||!sameMembership(watchlist?.films,watchMembers))throw failed('published_epg_fence');
 await fenced(database(env),[
  ['UPDATE published_epg_authority SET mode=\'r2\' WHERE id=1 AND mode=\'d1\' AND programme_run_id=? AND mirror_programme_run_id=? AND mirror_etag=? AND mirror_watchlist_etag=? AND generation=?',[authority.programmeRunId,authority.mirrorProgrammeRunId,authority.mirrorEtag,authority.mirrorWatchlistEtag,authority.generation]],
  [FENCE_SQL,[]],
 ]);
 const after=await readAuthority(env);
 if(after.mode!=='r2'||after.programmeRunId!==authority.programmeRunId)throw failed('published_epg_fence');
 return after;
}
