// ADR 0072. The metadata.json working set used by beginSync and metadataSync.
// Mode r2, and any database that is not schema v6 with these tables, keeps the R2 object.
// Mode d1 reads and writes this table. A failed read does not fall back to the object.
// This module does not import. The Worker bundle wraps it in a scope.

export const METADATA_FRESH_MS=30*86400000;
const MIRROR_KEY='metadata.json';
const JSON_PUT={httpMetadata:{contentType:'application/json'}};
const FENCE_SQL='UPDATE metadata_cache_cas SET ok=changes() WHERE id=1';

export function mergeWatchlistFilm(film,record){
 return record?{...record,...film,aliases:record.aliases}:film;
}
export function metadataPending(film,now=Date.now()){
 return !film.metadataAt||film.peopleVersion!==1||film.peopleNamesVersion!==2||!film.synopsisFetchedAt||now-Date.parse(film.metadataAt)>METADATA_FRESH_MS;
}

const clock=value=>typeof value==='string'&&value.length?value:null;
const integer=value=>Number.isInteger(value)?value:null;
export function metadataCacheColumns(record){
 const body=record&&typeof record==='object'&&!Array.isArray(record)?record:{};
 return {metadataAt:clock(body.metadataAt),synopsisFetchedAt:clock(body.synopsisFetchedAt),peopleNamesVersion:integer(body.peopleNamesVersion),peopleLocalizedAt:clock(body.peopleLocalizedAt),peopleVersion:integer(body.peopleVersion)};
}

function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function binding(db){return typeof db?.prepare==='function';}
async function one(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).first())??null;
 return (await db.get(sql,params))??null;
}
async function many(db,sql,params=[]){
 if(binding(db))return (await db.prepare(sql).bind(...params).all()).results||[];
 return (await db.all(sql,params))||[];
}
function sameValue(left,right){
 if(left===right)return true;
 if(typeof left!==typeof right||left===null||right===null||Array.isArray(left)!==Array.isArray(right))return false;
 if(Array.isArray(left))return left.length===right.length&&left.every((item,index)=>sameValue(item,right[index]));
 if(typeof left==='object'){const keys=Object.keys(left);return keys.length===Object.keys(right).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(right,key)&&sameValue(left[key],right[key]));}
 return false;
}
function payload(record){return JSON.stringify(record===undefined?null:record);}

export async function readAuthority(db){
 if(!db)return {mode:'r2',tables:false,version:null,ready:false};
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return {mode:'r2',tables:false,version:null,ready:false};
  throw failed('metadata_cache_unavailable',error);
 }
 const names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metadata_cache','metadata_cache_authority','metadata_cache_cas')")).map(row=>row.name);
 const tables=names.includes('metadata_cache')&&names.includes('metadata_cache_authority')&&names.includes('metadata_cache_cas');
 if(version!==6||!tables)return {mode:'r2',tables,version,ready:false};
 const row=await one(db,'SELECT mode, cache_generation AS cacheGeneration, mirror_generation AS mirrorGeneration, mirror_etag AS mirrorEtag FROM metadata_cache_authority WHERE id=1');
 if(!row||(row.mode!=='r2'&&row.mode!=='d1'))return {mode:'r2',tables:true,version,ready:false};
 return {mode:row.mode,tables:true,version,ready:row.mode==='d1',cacheGeneration:row.cacheGeneration,mirrorGeneration:row.mirrorGeneration,mirrorEtag:row.mirrorEtag??null};
}

export async function readAllRecords(db){
 let rows;
 try{rows=await many(db,'SELECT cache_key, payload_json FROM metadata_cache ORDER BY cache_key');}
 catch(error){throw failed('metadata_cache_unavailable',error);}
 const records={};
 for(const row of rows){
  try{records[row.cache_key]=JSON.parse(row.payload_json);}
  catch{throw failed('metadata_cache_unavailable');}
 }
 return records;
}

async function readMirror(env){
 const object=await env.BUCKET.get(MIRROR_KEY);
 if(!object)return {};
 const value=await object.json();
 return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}
function putMirror(bucket,text,onlyIf){
 return bucket.put(MIRROR_KEY,text,{...JSON_PUT,...(onlyIf?{onlyIf}:{})});
}
async function rememberMirror(db,generation,etag,mode){
 await db.prepare('UPDATE metadata_cache_authority SET mirror_generation=?, mirror_etag=? WHERE id=1 AND mode=? AND cache_generation=?').bind(generation,etag,mode,generation).run();
 return readAuthority(db);
}
async function publishMirror(db,bucket,records,authority){
 const text=JSON.stringify(records);
 let saved=authority.mirrorEtag?await putMirror(bucket,text,{etagMatches:authority.mirrorEtag}):null;
 if(!saved){
  const current=await bucket.get(MIRROR_KEY);
  if(!current)saved=await putMirror(bucket,text,{etagDoesNotMatch:'*'});
  else{
   let parsed;
   try{parsed=await current.json();}catch{parsed=undefined;}
   if(parsed!==undefined&&sameValue(parsed,records))saved={etag:current.etag};
   else saved=await putMirror(bucket,text,{etagMatches:current.etag});
  }
 }
 if(!saved)return {mirrored:false,authority};
 const next=await rememberMirror(db,authority.cacheGeneration,saved.etag,authority.mode);
 return {mirrored:next.mirrorGeneration===authority.cacheGeneration&&next.mirrorEtag===saved.etag,etag:saved.etag,authority:next};
}

export async function loadMetadataWorkingSet(env){
 const authority=await readAuthority(env?.DB);
 if(authority.mode!=='d1')return {mode:'r2',records:await readMirror(env),complete:true,authority};
 const records=await readAllRecords(env.DB);
 let current=authority;
 if(authority.cacheGeneration!==authority.mirrorGeneration){
  try{const repaired=await publishMirror(env.DB,env.BUCKET,records,authority);if(repaired.authority)current=repaired.authority;}
  catch{/* the decision still uses the rows above */}
 }
 return {mode:'d1',records,complete:true,authority:current};
}

async function fenced(db,statements){
 if(typeof db.batch!=='function')throw failed('metadata_cache_unavailable');
 const prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));
 try{await db.batch(prepared);}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message))throw failed('metadata_cache_cas',error);
  throw failed('metadata_cache_unavailable',error);
 }
}
function upsert(key,record,generation){
 const cols=metadataCacheColumns(record);
 return ['INSERT INTO metadata_cache (cache_key,payload_json,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at,people_version,generation) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,metadata_at=excluded.metadata_at,synopsis_fetched_at=excluded.synopsis_fetched_at,people_names_version=excluded.people_names_version,people_localized_at=excluded.people_localized_at,people_version=excluded.people_version,generation=excluded.generation',[key,payload(record),cols.metadataAt,cols.synopsisFetchedAt,cols.peopleNamesVersion,cols.peopleLocalizedAt,cols.peopleVersion,generation]];
}
function deleteMissing(keys){
 if(!keys.length)return ['DELETE FROM metadata_cache',[]];
 return [`DELETE FROM metadata_cache WHERE cache_key NOT IN (${keys.map(()=>'?').join(',')})`,keys];
}

export async function commitMetadataCache(db,bucket,records,authority){
 if(!authority||authority.mode!=='d1')throw failed('metadata_cache_not_authoritative');
 if(!records||typeof records!=='object'||Array.isArray(records))throw failed('metadata_cache_mirror_invalid');
 const generation=authority.cacheGeneration,next=generation+1,keys=Object.keys(records);
 const statements=[
  ['UPDATE metadata_cache_authority SET cache_generation=? WHERE id=1 AND mode=\'d1\' AND cache_generation=?',[next,generation]],
  [FENCE_SQL,[]],
  ...keys.map(key=>upsert(key,records[key],next)),
 ];
 if(authority.complete!==false)statements.push(deleteMissing(keys));
 await fenced(db,statements);
 const committed=await readAuthority(db);
 if(committed.cacheGeneration!==next)throw failed('metadata_cache_cas');
 let mirrored=false,current=committed;
 try{const published=await publishMirror(db,bucket,records,committed);mirrored=published.mirrored;if(published.authority)current=published.authority;}
 catch{mirrored=false;}
 return {mode:'d1',cacheGeneration:next,mirrored,authority:current};
}

export async function saveMetadataWorkingSet(env,records,working){
 if(!working||working.mode!=='d1'){
  await putMirror(env.BUCKET,JSON.stringify(records));
  return {mode:'r2'};
 }
 return commitMetadataCache(env.DB,env.BUCKET,records,{...working.authority,complete:working.complete!==false,mode:'d1'});
}

async function fencedMirror(bucket){
 const object=await bucket.get(MIRROR_KEY);
 if(!object)throw failed('metadata_cache_mirror_missing');
 const etag=object.etag??null;
 let records;
 try{records=await object.json();}catch{throw failed('metadata_cache_mirror_invalid');}
 if(!records||typeof records!=='object'||Array.isArray(records))throw failed('metadata_cache_mirror_invalid');
 const again=await bucket.head(MIRROR_KEY);
 if((again?.etag??null)!==etag)throw failed('metadata_cache_fence');
 return {records,etag};
}
async function prove(db,records){
 const stored=await readAllRecords(db);
 const left=Object.keys(records),right=Object.keys(stored);
 if(left.length!==right.length||left.some(key=>!Object.prototype.hasOwnProperty.call(stored,key)||!sameValue(records[key],stored[key])))throw failed('metadata_cache_loss');
 return stored;
}

export async function importMetadataCache(db,bucket,{confirm}={}){
 if(confirm!=='load')throw failed('metadata_cache_confirm');
 const authority=await readAuthority(db);
 if(authority.version!==6||!authority.tables)throw failed('metadata_cache_schema');
 if(authority.mode==='d1')throw failed('metadata_cache_authoritative');
 const {records,etag}=await fencedMirror(bucket);
 const keys=Object.keys(records);
 const next=(authority.cacheGeneration??0)+1;
 await fenced(db,[
  ['UPDATE metadata_cache_authority SET cache_generation=?, mirror_generation=?, mirror_etag=? WHERE id=1 AND mode=\'r2\' AND cache_generation=?',[next,next,etag,authority.cacheGeneration]],
  [FENCE_SQL,[]],
  ['DELETE FROM metadata_cache',[]],
  ...keys.map(key=>upsert(key,records[key],next)),
 ]);
 await prove(db,records);
 const after=await readAuthority(db);
 if(after.mode!=='r2'||after.cacheGeneration!==next||after.mirrorGeneration!==next||after.mirrorEtag!==etag)throw failed('metadata_cache_loss');
 return {mode:'r2',keys:keys.length,cacheGeneration:next,mirrorGeneration:next,mirrorEtag:etag};
}

export async function activateMetadataCache(db,bucket,{confirm}={}){
 if(confirm!=='activate')throw failed('metadata_cache_confirm');
 const authority=await readAuthority(db);
 if(authority.version!==6||!authority.tables)throw failed('metadata_cache_schema');
 if(authority.mode!=='r2')throw failed('metadata_cache_authoritative');
 if(authority.cacheGeneration!==authority.mirrorGeneration)throw failed('metadata_cache_fence');
 const {records,etag}=await fencedMirror(bucket);
 if(etag!==authority.mirrorEtag)throw failed('metadata_cache_fence');
 await prove(db,records);
 await fenced(db,[
  ['UPDATE metadata_cache_authority SET mode=\'d1\' WHERE id=1 AND mode=\'r2\' AND cache_generation=? AND mirror_generation=? AND mirror_etag=? AND cache_generation=mirror_generation',[authority.cacheGeneration,authority.mirrorGeneration,authority.mirrorEtag]],
  [FENCE_SQL,[]],
 ]);
 const after=await readAuthority(db);
 if(after.mode!=='d1'||after.cacheGeneration!==authority.cacheGeneration)throw failed('metadata_cache_cas');
 return after;
}

// Leaves the rows in place and returns readers to metadata.json. It does not write R2.
export async function revertMetadataCache(db,{confirm}={}){
 if(confirm!=='r2')throw failed('metadata_cache_confirm');
 const authority=await readAuthority(db);
 if(authority.version!==6||!authority.tables)throw failed('metadata_cache_schema');
 if(authority.mode!=='d1')throw failed('metadata_cache_not_authoritative');
 await fenced(db,[
  ['UPDATE metadata_cache_authority SET mode=\'r2\' WHERE id=1 AND mode=\'d1\' AND cache_generation=?',[authority.cacheGeneration]],
  [FENCE_SQL,[]],
 ]);
 const after=await readAuthority(db);
 if(after.mode!=='r2'||after.cacheGeneration!==authority.cacheGeneration)throw failed('metadata_cache_cas');
 return after;
}

// The projector calls this with its query adapter. Mode r2 leaves the R2 object in place.
// Mode d1 replaces store.metadata before the view is built and never writes the cache.
export async function useAuthoritativeMetadata(db,store){
 const authority=await readAuthority(db);
 if(authority.mode!=='d1')return authority;
 try{store.metadata=await readAllRecords(db);}
 catch(error){throw failed('metadata_cache_unavailable',error);}
 return authority;
}
