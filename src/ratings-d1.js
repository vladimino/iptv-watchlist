// ADR 0084. Diary facts, confirmed ratings, the ratings run and the removal
// queue are D1-owned only when ratings_domain_authority is mode d1 and
// cutover open. The inserted marker is r2. A missing table below version 10
// stays on the objects. Some but not all of these tables fails closed.
// None of the tables on a later contract stays on the objects: this domain
// is not installed. Mode d1 with cutover held is not authority. Readers stay
// on R2 and a writer fails closed instead of writing R2. Mode d1 with cutover
// open does not fall back to R2. The view index in R2 is not a rating source
// once that marker is open: watched, actualRating and watchlist are replaced
// from ratings_view. Events stay in R2 as a projection of a confirmed rating.
// Archive receipts, ZIP bytes and HTML snapshots stay in R2.
// This module does not import. The Worker bundle wraps it.

export const DOCUMENT_BYTES=60000;
export const CONTRACT=10;
const FENCE_SQL='UPDATE ratings_domain_cas SET ok=changes() WHERE id=1';
const TABLES=['ratings_domain_authority','ratings_domain_cas','ratings_document','ratings_view'];
const EXACT=new Set([
 'letterboxd/facts/links.json',
 'letterboxd/facts/conflicts.json',
 'letterboxd/diary/history.json',
 'letterboxd/diary/state.json',
 'letterboxd/ratings/run.json',
 'letterboxd/ratings/migration.json',
 'enrichment/removal-rating-lookups.json',
]);

export function ratingsMutableKey(key){
 if(typeof key!=='string'||!key||key.includes('..')||key.startsWith('/'))return false;
 if(EXACT.has(key))return true;
 if(key.startsWith('letterboxd/facts/films/')&&key.endsWith('.json')&&key.length<240)return true;
 if(key.startsWith('letterboxd/facts/scans/')&&key.endsWith('.json')&&key.length<240)return true;
 return false;
}

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
 if(present===0)return idle(Number(version),true);
 if(present!==TABLES.length||Number(version)<CONTRACT)throw failed('ratings_domain_unavailable');
 let row;
 try{row=await one(db,"SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1");}
 catch(error){throw failed('ratings_domain_unavailable',error);}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.cutover!=='open'&&row.cutover!=='held'))throw failed('ratings_domain_unavailable');
 const generation=Number(row.generation);
 return {mode:row.mode,cutover:row.cutover,tables:true,version:Number(version),ready:row.mode==='d1'&&row.cutover==='open',binding:true,generation};
}

export async function ratingsReady(env){
 return (await readRatingsAuthority(database(env),env)).ready===true;
}

async function requireOpen(env,mode){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(authority.tables&&authority.mode==='d1'&&authority.cutover==='held'&&mode==='d1')throw failed('ratings_domain_not_authoritative');
 if(!authority.tables||authority.mode!==mode||authority.cutover!=='open')return {authority,db,open:false};
 return {authority,db,open:true};
}

async function readParts(db,key){
 const rows=await many(db,'SELECT part, body, etag FROM ratings_document WHERE key=? ORDER BY part',[key]);
 if(!rows.length)return {value:null,etag:null,text:null};
 const etag=rows[0].etag;
 if(rows.some((row,index)=>Number(row.part)!==index||row.etag!==etag))throw failed('ratings_domain_unavailable');
 const text=rows.map(row=>row.body).join('');
 if(await digest(text)!==etag)throw failed('ratings_domain_unavailable');
 let value;
 try{value=JSON.parse(text);}catch(error){throw failed('ratings_domain_unavailable',error);}
 return {value,etag,text};
}

export async function readOwned(env,key){
 if(!ratingsMutableKey(key))return {owned:false};
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.ready)return {owned:false};
 const document=await readParts(db,key);
 return {owned:true,value:document.value,etag:document.etag};
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

export async function putOwned(env,key,previousEtag,value,{mode='d1'}={}){
 if(!ratingsMutableKey(key))return {owned:false};
 if(mode!=='d1'&&mode!=='r2')throw failed('ratings_domain_unavailable');
 const gate=await requireOpen(env,mode);
 if(!gate.open)return {owned:false};
 const text=JSON.stringify(value);
 const etag=await digest(text);
 const now=new Date().toISOString();
 try{await fenced(gate.db,writeStatements(key,text,etag,now,previousEtag,mode));}
 catch(error){
  if(error.code==='ratings_domain_fence')return {owned:true,saved:null};
  throw error;
 }
 const stored=await readParts(gate.db,key);
 if(stored.etag!==etag)return {owned:true,saved:null};
 return {owned:true,saved:{etag}};
}

export async function casOwned(env,key,empty,apply){
 if(!ratingsMutableKey(key))return {owned:false};
 const gate=await requireOpen(env,'d1');
 if(!gate.open)return {owned:false};
 for(let attempt=0;attempt<5;attempt++){
  const current=await readParts(gate.db,key);
  const base=current.value??clone(empty);
  const next=await apply(clone(base),current.etag);
  if(next==null)return {owned:true,result:{value:base,changed:false}};
  const saved=await putOwned(env,key,current.etag,next);
  if(!saved.owned)throw failed('ratings_domain_not_authoritative');
  if(saved.saved)return {owned:true,result:{value:next,changed:true}};
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

export async function projectView(env,records){
 const gate=await requireOpen(env,'d1');
 if(!gate.open)return {owned:false,changed:0};
 const list=(records||[]).filter(record=>record&&record.factKey&&record.links);
 if(!list.length)return {owned:true,changed:0};
 const wanted=new Map();
 for(const record of list){
  const row=projectionRow(record);
  for(const id of projectionIds(record.links))wanted.set(id,{...row,alias_id:id});
 }
 if(!wanted.size)return {owned:true,changed:0};
 if(wanted.size>200)throw failed('ratings_domain_unavailable');
 const ids=[...wanted.keys()];
 const existing=new Map((await many(gate.db,'SELECT alias_id, fact_key, watched, actual_rating, watchlist, rating_known FROM ratings_view WHERE alias_id IN ('+ids.map(()=>'?').join(',')+')',ids)).map(row=>[row.alias_id,row]));
 const now=new Date().toISOString();
 const statements=[];
 let changed=0;
 for(const [id,row] of wanted){
  const prior=existing.get(id);
  const watched=row.present.watched?row.watched:(prior?prior.watched:null);
  const watchlist=row.present.watchlist?row.watchlist:(prior?prior.watchlist:null);
  const ratingKnown=row.present.rating?1:(prior?Number(prior.rating_known):0);
  const actual=row.present.rating?row.actual_rating:(prior?prior.actual_rating:null);
  if(prior&&prior.fact_key===row.fact_key&&(prior.watched??null)===(watched??null)&&(prior.watchlist??null)===(watchlist??null)&&Number(prior.rating_known)===ratingKnown&&(prior.actual_rating??null)===(actual??null))continue;
  changed++;
  statements.push(['INSERT INTO ratings_view (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(alias_id) DO UPDATE SET fact_key=excluded.fact_key, watched=excluded.watched, actual_rating=excluded.actual_rating, watchlist=excluded.watchlist, rating_known=excluded.rating_known, updated_at=excluded.updated_at',[id,row.fact_key,watched,actual,watchlist,ratingKnown,now]]);
 }
 if(!statements.length)return {owned:true,changed:0};
 const batch=[["UPDATE ratings_domain_authority SET generation=generation WHERE id=1 AND mode='d1' AND cutover='open'",[]],[FENCE_SQL,[]],...statements,["UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1 AND mode='d1' AND cutover='open'",[]]];
 await fenced(gate.db,batch);
 return {owned:true,changed};
}

export async function overlayView(env,index){
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.ready)return index;
 const rows=await many(db,'SELECT alias_id, watched, actual_rating, watchlist, rating_known FROM ratings_view');
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

export async function importDocuments(env,documents,{confirm}={}){
 if(confirm!=='load')throw failed('ratings_domain_not_confirmed');
 const gate=await requireOpen(env,'r2');
 if(!gate.open)throw failed('ratings_domain_not_ready');
 if(!Array.isArray(documents))throw failed('ratings_domain_unavailable');
 const seen=new Set();
 const prepared=[];
 for(const item of documents){
  if(!item||!ratingsMutableKey(item.key)||typeof item.text!=='string'||seen.has(item.key))throw failed('ratings_domain_unavailable');
  seen.add(item.key);
  let value;
  try{value=JSON.parse(item.text);}catch{throw failed('ratings_domain_unavailable');}
  if(value==null||typeof value!=='object'||Array.isArray(value))throw failed('ratings_domain_unavailable');
  prepared.push({key:item.key,text:item.text,etag:await digest(item.text),value});
 }
 const now=new Date().toISOString();
 const probe=["UPDATE ratings_domain_authority SET generation=generation WHERE id=1 AND mode='r2' AND cutover='open'",[]];
 const inserts=[];
 for(const item of prepared){
  const parts=splitText(item.text);
  for(let part=0;part<parts.length;part++)inserts.push(['INSERT INTO ratings_document (key, part, body, etag, updated_at) VALUES (?,?,?,?,?)',[item.key,part,parts[part],item.etag,now]]);
 }
 const view=new Map();
 for(const item of prepared){
  if(!item.key.startsWith('letterboxd/facts/films/'))continue;
  const record=item.value;
  if(!record.factKey||!record.links)continue;
  const row=projectionRow(record);
  for(const id of projectionIds(record.links))view.set(id,{...row,alias_id:id});
 }
 const viewStatements=[...view].map(([id,row])=>['INSERT INTO ratings_view (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES (?,?,?,?,?,?,?)',[id,row.fact_key,row.present.watched?row.watched:null,row.present.rating?row.actual_rating:null,row.present.watchlist?row.watchlist:null,row.present.rating?1:0,now]]);
 await fenced(gate.db,[probe,[FENCE_SQL,[]],['DELETE FROM ratings_document',[]],['DELETE FROM ratings_view',[]]]);
 const chunkAt=200;
 for(let index=0;index<inserts.length;index+=chunkAt)await fenced(gate.db,[probe,[FENCE_SQL,[]],...inserts.slice(index,index+chunkAt)]);
 await fenced(gate.db,[probe,[FENCE_SQL,[]],...viewStatements,["UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1 AND mode='r2' AND cutover='open'",[]]]);
 const authority=await readRatingsAuthority(gate.db,env);
 return {mode:authority.mode,cutover:authority.cutover,generation:authority.generation,documents:prepared.length};
}

export async function activateDocuments(env,documents,{confirm}={}){
 if(confirm!=='activate')throw failed('ratings_domain_not_confirmed');
 const gate=await requireOpen(env,'r2');
 if(!gate.open)throw failed('ratings_domain_not_ready');
 const stored=await listDocuments(env);
 const incoming=new Map();
 for(const item of documents||[]){
  if(!ratingsMutableKey(item?.key)||typeof item.text!=='string')throw failed('ratings_domain_unavailable');
  incoming.set(item.key,item.text);
 }
 if(incoming.size!==stored.documents.length)throw failed('ratings_domain_fence');
 for(const item of stored.documents){
  if(incoming.get(item.key)!==item.text||await digest(item.text)!==item.etag)throw failed('ratings_domain_fence');
 }
 await fenced(gate.db,[
  ["UPDATE ratings_domain_authority SET mode='d1', cutover='held' WHERE id=1 AND mode='r2' AND cutover='open' AND generation=?",[gate.authority.generation]],
  [FENCE_SQL,[]],
 ]);
 const authority=await readRatingsAuthority(gate.db,env);
 if(authority.mode!=='d1'||authority.cutover!=='held')throw failed('ratings_domain_fence');
 return authority;
}

export async function releaseHeld(env,{confirm}={}){
 if(confirm!=='release-hold')throw failed('ratings_domain_not_confirmed');
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.tables||authority.mode!=='d1'||authority.cutover!=='held')throw failed('ratings_domain_not_ready');
 await fenced(db,[
  ["UPDATE ratings_domain_authority SET mode='r2', cutover='open' WHERE id=1 AND mode='d1' AND cutover='held' AND generation=?",[authority.generation]],
  [FENCE_SQL,[]],
 ]);
 return readRatingsAuthority(db,env);
}

export async function sealHeld(env,{confirm,generation}={}){
 if(confirm!=='seal-hold')throw failed('ratings_domain_not_confirmed');
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.tables||authority.mode!=='d1'||authority.cutover!=='held'||authority.generation!==generation)throw failed('ratings_domain_not_ready');
 await fenced(db,[
  ["UPDATE ratings_domain_authority SET cutover='open' WHERE id=1 AND mode='d1' AND cutover='held' AND generation=?",[generation]],
  [FENCE_SQL,[]],
 ]);
 const next=await readRatingsAuthority(db,env);
 if(!next.ready)throw failed('ratings_domain_fence');
 return next;
}

export async function revertMarker(env,{confirm}={}){
 if(confirm!=='r2')throw failed('ratings_domain_not_confirmed');
 const db=database(env);
 const authority=await readRatingsAuthority(db,env);
 if(!authority.ready)throw failed('ratings_domain_not_authoritative');
 await fenced(db,[
  ["UPDATE ratings_domain_authority SET mode='r2', cutover='open' WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?",[authority.generation]],
  [FENCE_SQL,[]],
 ]);
 const next=await readRatingsAuthority(db,env);
 if(next.mode!=='r2'||next.cutover!=='open')throw failed('ratings_domain_fence');
 return next;
}
