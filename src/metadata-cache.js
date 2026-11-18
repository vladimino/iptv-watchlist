// ADR 0073, ADR 0162. The metadata.json working set used by beginSync and metadataSync. D1 is the
// only authority: the cache is served only while its marker says mode d1. A marker in any other
// mode, a missing binding, a missing schema_contract, a contract below version 6 or missing tables
// fails closed (metadata_cache_unavailable). Only the explicit local stand-in
// (METADATA_CACHE_DB_OPTIONAL=standin) keeps the R2 object, for development and the test harness.
// Mode d1 reads and writes the table and does not fall back to the object; metadata.json is the
// mirror written after each commit. This module does not import. The Worker bundle wraps it in a scope.

export const METADATA_FRESH_MS=30*86400000;
const MIRROR_KEY='metadata.json';
const JSON_PUT={httpMetadata:{contentType:'application/json'}};
const FENCE_SQL='UPDATE metadata_cache_cas SET ok=changes() WHERE id=1';
// D1 rejects a statement with more than 100 bound parameters. Deletes must stay under that cap.
const D1_BOUND_PARAMETERS=100;

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

function database(source){return binding(source)||typeof source?.get==='function'?source:source?.DB;}
function standin(source){return !!source&&!binding(source)&&typeof source?.get!=='function'&&source.METADATA_CACHE_DB_OPTIONAL==='standin';}
const STANDIN={mode:'standin',tables:false,version:null,ready:false};
// `source` is the Worker env (its DB binding and the explicit stand-in flag) or a database itself.
export async function readAuthority(source){
 const db=database(source),local=standin(source);
 if(!db){if(local)return STANDIN;throw failed('metadata_cache_unavailable');}
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error))&&local)return STANDIN;
  throw failed('metadata_cache_unavailable',error);
 }
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metadata_cache','metadata_cache_authority','metadata_cache_cas')")).map(row=>row.name);}
 catch(error){throw failed('metadata_cache_unavailable',error);}
 const tables=names.includes('metadata_cache')&&names.includes('metadata_cache_authority')&&names.includes('metadata_cache_cas');
 if(!(Number(version)>=6)){if(local)return {...STANDIN,tables,version};throw failed('metadata_cache_unavailable');}
 if(!tables)throw failed('metadata_cache_unavailable');
 let row;
 try{row=await one(db,'SELECT mode, cache_generation AS cacheGeneration, mirror_generation AS mirrorGeneration, mirror_etag AS mirrorEtag FROM metadata_cache_authority WHERE id=1');}
 catch(error){throw failed('metadata_cache_unavailable',error);}
 if(!row||row.mode!=='d1')throw failed('metadata_cache_unavailable');
 return {mode:row.mode,tables:true,version,ready:row.mode==='d1',cacheGeneration:Number(row.cacheGeneration),mirrorGeneration:Number(row.mirrorGeneration),mirrorEtag:row.mirrorEtag??null};
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
function owns(authority,generation){
 return !!authority&&authority.mode==='d1'&&authority.cacheGeneration===generation;
}
async function rememberMirror(db,generation,etag){
 await db.prepare('UPDATE metadata_cache_authority SET mirror_generation=?, mirror_etag=? WHERE id=1 AND mode=\'d1\' AND cache_generation=?').bind(generation,etag,generation).run();
 return readAuthority(db);
}
async function sameMirror(object,records){
 if(!object)return null;
 let parsed;
 try{parsed=await object.json();}catch{parsed=undefined;}
 return parsed!==undefined&&sameValue(parsed,records)?{etag:object.etag}:null;
}
// Publishes only while this generation is still the cache generation. A newer commit
// may replace this object. This generation must not replace a newer one.
async function publishMirror(db,bucket,records,authority){
 const generation=authority.cacheGeneration,text=JSON.stringify(records);
 let current=await readAuthority(db);
 if(!owns(current,generation))return {mirrored:false,superseded:true,authority:current};
 let saved=current.mirrorEtag?await putMirror(bucket,text,{etagMatches:current.mirrorEtag}):null;
 if(!saved){
  current=await readAuthority(db);
  if(!owns(current,generation))return {mirrored:false,superseded:true,authority:current};
  const object=await bucket.get(MIRROR_KEY);
  saved=await sameMirror(object,records);
  if(!saved){
   current=await readAuthority(db);
   if(!owns(current,generation))return {mirrored:false,superseded:true,authority:current};
   saved=object?await putMirror(bucket,text,{etagMatches:object.etag}):await putMirror(bucket,text,{etagDoesNotMatch:'*'});
  }
 }
 if(!saved){
  current=await readAuthority(db);
  if(!owns(current,generation))return {mirrored:false,superseded:true,authority:current};
  saved=await sameMirror(await bucket.get(MIRROR_KEY),records);
  if(!saved)return {mirrored:false,authority:current};
 }
 const next=await rememberMirror(db,generation,saved.etag);
 return {mirrored:next.mirrorGeneration===generation&&next.mirrorEtag===saved.etag,etag:saved.etag,authority:next};
}

// Records and the compare-and-swap token come from one generation. A repair that loses
// the race reads that newer generation again. It does not return the older records
// with the newer token.
async function readStableCache(db){
 for(let attempt=0;attempt<3;attempt++){
  const before=await readAuthority(db);
  if(before.mode!=='d1')throw failed('metadata_cache_not_authoritative');
  const records=await readAllRecords(db);
  const after=await readAuthority(db);
  if(after.mode==='d1'&&after.cacheGeneration===before.cacheGeneration)return {records,authority:after};
 }
 throw failed('metadata_cache_fence');
}
export async function loadMetadataWorkingSet(env){
 const authority=await readAuthority(env);
 if(authority.mode==='standin')return {mode:'standin',records:await readMirror(env),complete:true,authority};
 let snapshot=await readStableCache(env.DB);
 for(let attempt=0;attempt<3;attempt++){
  if(snapshot.authority.cacheGeneration===snapshot.authority.mirrorGeneration)break;
  let repaired;
  try{repaired=await publishMirror(env.DB,env.BUCKET,snapshot.records,snapshot.authority);}
  catch{break;}
  if(!repaired.superseded&&repaired.authority&&repaired.authority.cacheGeneration===snapshot.authority.cacheGeneration){
   snapshot={records:snapshot.records,authority:repaired.authority};
   break;
  }
  snapshot=await readStableCache(env.DB);
 }
 return {mode:'d1',records:snapshot.records,complete:true,authority:snapshot.authority};
}

async function fenced(db,statements){
 if(typeof db.batch!=='function')throw failed('metadata_cache_unavailable');
 if(statements.some(([,params])=>params.length>D1_BOUND_PARAMETERS))throw failed('metadata_cache_unavailable');
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
function deleteStale(generation){
 return ['DELETE FROM metadata_cache WHERE generation<>?',[generation]];
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
 if(authority.complete!==false)statements.push(deleteStale(next));
 await fenced(db,statements);
 const committed=await readAuthority(db);
 if(committed.cacheGeneration!==next)throw failed('metadata_cache_cas');
 let mirrored=false,current=committed;
 try{const published=await publishMirror(db,bucket,records,committed);mirrored=published.mirrored;if(published.authority&&published.authority.cacheGeneration===next)current=published.authority;}
 catch{mirrored=false;}
 return {mode:'d1',cacheGeneration:next,mirrored,authority:current};
}

export async function saveMetadataWorkingSet(env,records,working){
 if(working?.mode==='d1')return commitMetadataCache(env.DB,env.BUCKET,records,{...working.authority,complete:working.complete!==false,mode:'d1'});
 const authority=await readAuthority(env);
 if(authority.mode!=='standin')throw failed('metadata_cache_not_authoritative');
 await putMirror(env.BUCKET,JSON.stringify(records));
 return {mode:'standin'};
}

// The projector calls this with its query adapter, only at contract version 6 or later. Mode d1
// replaces store.metadata before the view is built and never writes the cache; any other marker throws.
export async function useAuthoritativeMetadata(db,store){
 const authority=await readAuthority(db);
 if(authority.mode!=='d1')return authority;
 try{store.metadata=await readAllRecords(db);}
 catch(error){throw failed('metadata_cache_unavailable',error);}
 return authority;
}
