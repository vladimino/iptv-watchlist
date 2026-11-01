// ADR 0076. Mutable prediction state is owned by D1 only after its own marker is switched.
// Schema v6 and earlier keep the R2 objects and do not write these tables. Schema v7 with a
// missing table or marker fails closed. Mode d1 reads and writes these tables and does not
// fall back to the objects. Immutable bodies stay in R2 and are verified before a pointer moves.
// This module does not import. The Worker bundle wraps it in a scope. It does not insert a film row.

export const PREDICTION_HISTORY_LIMIT=80;
export const PREDICTION_QUEUE_CHARS=900000;
const FENCE_SQL='UPDATE prediction_domain_cas SET ok=changes() WHERE id=1';
const QUEUE_KEY='enrichment/prediction-queue.json';
const PROFILE_KEY='enrichment/profile/current.json';
const RUNNER_KEY='enrichment/runner-lease.json';
const WRITER_KEY='enrichment/writer-lease.json';
const LATEST_KEY='enrichment/latest-run.json';
const TABLES=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run'];

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
async function fenced(db,statements){
 if(typeof db?.batch!=='function')throw failed('prediction_domain_unavailable');
 const prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));
 try{await db.batch(prepared);}
 catch(error){
  const message=String(error?.message||error);
  if(/CHECK constraint failed|UNIQUE constraint failed/i.test(message))throw failed('prediction_domain_cas',error);
  throw failed('prediction_domain_unavailable',error);
 }
}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
async function sha256(value){
 const text=typeof value==='string'?value:JSON.stringify(canonical(value));
 const bytes=new TextEncoder().encode(text);
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function filmIdFrom(key,marker){
 const match=String(key).match(new RegExp('^enrichment/films/([^/]+)/'+marker+'\\.json$'));
 if(!match)return null;
 try{return decodeURIComponent(match[1]);}catch{return null;}
}
function runIdFrom(key){
 const match=String(key).match(/^enrichment\/runs\/([A-Za-z0-9_-]{1,100})\.json$/);
 return match?match[1]:null;
}
export function predictionMutableKey(key){
 if(key===QUEUE_KEY)return 'queue';
 if(key===PROFILE_KEY)return 'profile';
 if(key===RUNNER_KEY)return 'runner';
 if(key===WRITER_KEY)return 'writer';
 if(key===LATEST_KEY)return 'latest';
 if(runIdFrom(key))return 'run';
 if(filmIdFrom(key,'fingerprint'))return 'fingerprint';
 if(filmIdFrom(key,'predictions'))return 'predictions';
 return null;
}
function leaseName(kind){return kind==='writer'?'writer':'runner';}

export async function readPredictionAuthority(db){
 if(!db)return {mode:'r2',tables:false,version:null,ready:false,generation:0,queueGeneration:0,profileGeneration:0};
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return {mode:'r2',tables:false,version:null,ready:false,generation:0,queueGeneration:0,profileGeneration:0};
  throw failed('prediction_domain_unavailable',error);
 }
 if(version!==7)return {mode:'r2',tables:false,version,ready:false,generation:0,queueGeneration:0,profileGeneration:0};
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")")).map(row=>row.name);}
 catch(error){throw failed('prediction_domain_unavailable',error);}
 if(!TABLES.every(name=>names.includes(name)))throw failed('prediction_domain_unavailable');
 let row;
 try{row=await one(db,'SELECT mode, generation, queue_generation AS queueGeneration, profile_generation AS profileGeneration FROM prediction_domain_authority WHERE id=1');}
 catch(error){throw failed('prediction_domain_unavailable',error);}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1'))throw failed('prediction_domain_unavailable');
 return {mode:row.mode,tables:true,version,ready:row.mode==='d1',generation:Number(row.generation),queueGeneration:Number(row.queueGeneration),profileGeneration:Number(row.profileGeneration)};
}

async function claim(db,generation){
 await fenced(db,[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'r2\' AND generation=?',[generation+1,generation]],
  [FENCE_SQL,[]],
 ]);
 const now=await readPredictionAuthority(db);
 if(now.mode!=='r2'||now.generation!==generation+1)throw failed('prediction_domain_cas');
 return now;
}

async function objectText(bucket,key){
 const object=await bucket.get(key);
 if(!object)return null;
 return object.text?await object.text():JSON.stringify(await object.json());
}
async function readBody(bucket,key){
 const text=await objectText(bucket,key);
 if(text==null)throw failed('prediction_domain_body_missing');
 try{return JSON.parse(text);}catch{throw failed('prediction_domain_body_missing');}
}
async function verified(bucket,key,hash){
 const parsed=await readBody(bucket,key);
 if(await sha256(parsed)!==hash)throw failed('prediction_domain_body_mismatch');
 return parsed;
}

function featuresOf(value){
 return {fingerprintHash:value?.fingerprintHash??null,fingerprintSchemaVersion:value?.fingerprintSchemaVersion??null,fingerprintPromptVersion:value?.fingerprintPromptVersion??1,invalidatedAt:value?.invalidatedAt||null,generatedAt:value?.generatedAt||null,produced:value?.produced||null,previous:value?.previous??null,plotMechanics:Array.isArray(value?.plotMechanics)?value.plotMechanics:[],moodLabels:Array.isArray(value?.moodLabels)?value.moodLabels:[],execution:value?.execution&&typeof value.execution==='object'?value.execution:{}};
}
function displayOf(value){
 if(!value||typeof value!=='object')return {};
 const {r2Key:_key,contentSha256:_sha,replacedAt:_at,...body}=value;
 return body;
}
function fingerprintKey(filmId,hash){return 'enrichment/films/'+encodeURIComponent(filmId)+'/fingerprints/'+hash+'.json';}
function profileKey(version){return 'enrichment/profile/versions/'+version+'.json';}

async function loadQueue(db){
 const row=await one(db,'SELECT document_json AS document, generation FROM prediction_queue WHERE id=1');
 if(!row)return null;
 try{return JSON.parse(row.document);}catch{throw failed('prediction_domain_unavailable');}
}
async function loadProfile(env){
 const row=await one(env.DB,'SELECT version, profile_hash AS profileHash, created_at AS createdAt, r2_key AS r2Key, content_sha256 AS contentSha256, lineage_json AS lineage FROM prediction_profile WHERE active=1');
 if(!row)return null;
 const body=await verified(env.BUCKET,row.r2Key,row.contentSha256);
 if(body.profileHash!==row.profileHash||body.version!==row.version)throw failed('prediction_domain_body_mismatch');
 let lineage=null;if(row.lineage!=null){try{lineage=JSON.parse(row.lineage);}catch{throw failed('prediction_domain_unavailable');}}
 return {...body,lineage};
}
async function loadFingerprint(env,filmId){
 const row=await one(env.DB,'SELECT film_id AS filmId, fingerprint_hash AS fingerprintHash, schema_version AS schemaVersion, prompt_version AS promptVersion, generated_at AS generatedAt, invalidated_at AS invalidatedAt, r2_key AS r2Key, content_sha256 AS contentSha256, features_json AS features FROM prediction_fingerprint WHERE film_id=?',[filmId]);
 if(!row)return null;
 const body=await verified(env.BUCKET,row.r2Key,row.contentSha256);
 if(body.fingerprintHash!==row.fingerprintHash)throw failed('prediction_domain_body_mismatch');
 let features;try{features=JSON.parse(row.features);}catch{throw failed('prediction_domain_unavailable');}
 return {...body,generatedAt:row.generatedAt,invalidatedAt:row.invalidatedAt,fingerprintPromptVersion:row.promptVersion,fingerprintSchemaVersion:row.schemaVersion,produced:features.produced||null,previous:features.previous??null};
}
async function loadPredictionRecord(env,row){
 const body=await verified(env.BUCKET,row.r2Key,row.contentSha256);
 return {...body,r2Key:row.r2Key,contentSha256:row.contentSha256};
}
async function loadPredictions(env,filmId){
 const current=await one(env.DB,'SELECT taste_profile_version AS tasteProfileVersion, taste_profile_hash AS tasteProfileHash, fingerprint_hash AS fingerprintHash, r2_key AS r2Key, content_sha256 AS contentSha256, updated_at AS updatedAt, display_json AS display FROM prediction_pointer WHERE film_id=?',[filmId]);
 const history=await many(env.DB,'SELECT replaced_at AS replacedAt, r2_key AS r2Key, content_sha256 AS contentSha256, display_json AS display FROM prediction_lineage WHERE film_id=? ORDER BY replaced_at',[filmId]);
 if(!current&&!history.length)return null;
 let currentRecord=null;
 if(current){const display=JSON.parse(current.display);currentRecord={...await loadPredictionRecord(env,current),...display,r2Key:current.r2Key,contentSha256:current.contentSha256};}
 const past=[];
 for(const row of history){
  const display=JSON.parse(row.display);
  past.push({...await loadPredictionRecord(env,row),...display,r2Key:row.r2Key,contentSha256:row.contentSha256,replacedAt:row.replacedAt});
 }
 return {current:current?currentRecord:null,history:past};
}
async function loadLease(db,name){
 const row=await one(db,'SELECT token, document_json AS document FROM prediction_lease WHERE name=?',[name]);
 if(!row)return null;
 try{return {token:row.token,value:JSON.parse(row.document)};}catch{throw failed('prediction_domain_unavailable');}
}
async function loadRun(db,runId){
 const row=await one(db,'SELECT document_json AS document FROM prediction_run WHERE run_id=?',[runId]);
 if(!row)return null;
 try{return JSON.parse(row.document);}catch{throw failed('prediction_domain_unavailable');}
}
async function loadLatest(db){
 const row=await one(db,'SELECT document_json AS document FROM prediction_run WHERE latest=1');
 if(!row)return null;
 try{return JSON.parse(row.document);}catch{throw failed('prediction_domain_unavailable');}
}

export async function routeRead(env,key){
 const kind=predictionMutableKey(key);
 if(!kind)return {handled:false};
 const authority=await readPredictionAuthority(env?.DB);
 if(authority.mode!=='d1')return {handled:false};
 if(kind==='queue')return {handled:true,value:await loadQueue(env.DB)};
 if(kind==='profile')return {handled:true,value:await loadProfile(env)};
 if(kind==='runner'||kind==='writer'){const lease=await loadLease(env.DB,leaseName(kind));return {handled:true,value:lease?.value??null};}
 if(kind==='latest')return {handled:true,value:await loadLatest(env.DB)};
 if(kind==='run')return {handled:true,value:await loadRun(env.DB,runIdFrom(key))};
 if(kind==='fingerprint')return {handled:true,value:await loadFingerprint(env,filmIdFrom(key,'fingerprint'))};
 if(kind==='predictions')return {handled:true,value:await loadPredictions(env,filmIdFrom(key,'predictions'))};
 return {handled:false};
}

async function mirror(bucket,key,value){
 try{await bucket.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});}catch{/* the D1 commit stands; the mirror may lag */}
}

async function saveFingerprint(env,filmId,value,authority){
 const hash=value?.fingerprintHash;
 if(typeof hash!=='string'||!hash)throw failed('prediction_domain_body_missing');
 const key=fingerprintKey(filmId,hash);
 const body=await readBody(env.BUCKET,key);
 if(body.fingerprintHash!==hash)throw failed('prediction_domain_body_mismatch');
 const digest=await sha256(body);
 const features=featuresOf(value);
 const next=authority.generation+1;
 await fenced(env.DB,[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'d1\' AND generation=?',[next,authority.generation]],
  [FENCE_SQL,[]],
  ['INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET fingerprint_hash=excluded.fingerprint_hash,schema_version=excluded.schema_version,prompt_version=excluded.prompt_version,generated_at=excluded.generated_at,invalidated_at=excluded.invalidated_at,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,features_json=excluded.features_json',[filmId,hash,features.fingerprintSchemaVersion??0,features.fingerprintPromptVersion,features.generatedAt,features.invalidatedAt,key,digest,JSON.stringify(features)]],
 ]);
 await mirror(env.BUCKET,'enrichment/films/'+encodeURIComponent(filmId)+'/fingerprint.json',value);
}
function pointerColumns(record){
 return [record?.tasteProfileVersion??null,record?.tasteProfileHash??null,record?.fingerprintHash??null,record?.fingerprintSchemaVersion??null,record?.predictionPromptVersion??null,typeof record?.predictedRating==='number'?record.predictedRating:null,record?.r2Key,record?.contentSha256,record?.generatedAt||record?.updatedAt||record?.replacedAt||null];
}
async function savePredictions(env,filmId,bundle,authority){
 const history=Array.isArray(bundle?.history)?bundle.history:[];
 if(history.length>PREDICTION_HISTORY_LIMIT)throw failed('prediction_domain_budget');
 const records=[...(bundle?.current?[bundle.current]:[]),...history];
 for(const record of records){
  if(typeof record?.r2Key!=='string'||typeof record?.contentSha256!=='string')throw failed('prediction_domain_unlinked');
  const body=await verified(env.BUCKET,record.r2Key,record.contentSha256);
  if(body.filmId&&body.filmId!==filmId)throw failed('prediction_domain_body_mismatch');
 }
 const next=authority.generation+1;
 const statements=[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'d1\' AND generation=?',[next,authority.generation]],
  [FENCE_SQL,[]],
  ['DELETE FROM prediction_pointer WHERE film_id=?',[filmId]],
  ['DELETE FROM prediction_lineage WHERE film_id=?',[filmId]],
 ];
 if(bundle?.current){
  const current=bundle.current;
  const columns=pointerColumns(current);
  if(columns[8]==null)throw failed('prediction_domain_unlinked');
  statements.push(['INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[filmId,...columns,JSON.stringify(displayOf(current))]]);
 }
 for(const record of history){
  if(typeof record?.replacedAt!=='string'||!record.replacedAt)throw failed('prediction_domain_unlinked');
  statements.push(['INSERT INTO prediction_lineage (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,r2_key,content_sha256,display_json) VALUES (?,?,?,?,?,?,?,?)',[filmId,record.replacedAt,record.predictedRating??null,record.tasteProfileVersion??null,record.fingerprintHash??null,record.r2Key,record.contentSha256,JSON.stringify({...displayOf(record),replacedAt:record.replacedAt})]]);
 }
 await fenced(env.DB,statements);
 await mirror(env.BUCKET,'enrichment/films/'+encodeURIComponent(filmId)+'/predictions.json',bundle);
}
async function saveProfile(env,value,authority){
 const version=value?.version,hash=value?.profileHash;
 if(!Number.isInteger(version)||typeof hash!=='string')throw failed('prediction_domain_body_missing');
 const key=profileKey(version);
 const body=await readBody(env.BUCKET,key);
 if(body.profileHash!==hash||body.version!==version)throw failed('prediction_domain_body_mismatch');
 const digest=await sha256(body);
 const next=authority.generation+1,profileNext=authority.profileGeneration+1;
 const lineage=value.lineage===undefined?null:JSON.stringify(value.lineage);
 await fenced(env.DB,[
  ['UPDATE prediction_domain_authority SET generation=?, profile_generation=? WHERE id=1 AND mode=\'d1\' AND generation=? AND profile_generation=?',[next,profileNext,authority.generation,authority.profileGeneration]],
  [FENCE_SQL,[]],
  ['UPDATE prediction_profile SET active=0 WHERE active=1',[]],
  ['INSERT INTO prediction_profile (version,profile_hash,active,created_at,r2_key,content_sha256,lineage_json) VALUES (?,?,1,?,?,?,?) ON CONFLICT(version) DO UPDATE SET profile_hash=excluded.profile_hash,active=1,created_at=excluded.created_at,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,lineage_json=excluded.lineage_json',[version,hash,value.updatedAt||body.updatedAt||body.createdAt||new Date().toISOString(),key,digest,lineage]],
 ]);
 await mirror(env.BUCKET,PROFILE_KEY,value);
}
async function saveQueueDocument(env,queue,authority){
 const text=JSON.stringify(queue);
 if(text.length>PREDICTION_QUEUE_CHARS)throw failed('prediction_domain_budget');
 const next=authority.generation+1,queueNext=authority.queueGeneration+1;
 await fenced(env.DB,[
  ['UPDATE prediction_domain_authority SET generation=?, queue_generation=? WHERE id=1 AND mode=\'d1\' AND generation=? AND queue_generation=?',[next,queueNext,authority.generation,authority.queueGeneration]],
  [FENCE_SQL,[]],
  ['INSERT INTO prediction_queue (id,document_json,generation) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json, generation=excluded.generation',[text,queueNext]],
 ]);
 await mirror(env.BUCKET,QUEUE_KEY,queue);
 return queueNext;
}
async function saveRun(env,run,authority){
 const runId=run?.runId;
 if(typeof runId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(runId))throw failed('prediction_domain_unavailable');
 const next=authority.generation+1;
 const text=JSON.stringify(run);
 await fenced(env.DB,[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'d1\' AND generation=?',[next,authority.generation]],
  [FENCE_SQL,[]],
  ['UPDATE prediction_run SET latest=0 WHERE latest=1',[]],
  ['INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES (?,1,?,?) ON CONFLICT(run_id) DO UPDATE SET latest=1, updated_at=excluded.updated_at, document_json=excluded.document_json',[runId,run.updatedAt||run.completedAt||run.createdAt||new Date().toISOString(),text]],
 ]);
 await mirror(env.BUCKET,'enrichment/runs/'+runId+'.json',run);
 await mirror(env.BUCKET,LATEST_KEY,run);
}
async function saveLease(env,name,value,previousToken,authority){
 const token=crypto.randomUUID();
 const next=authority.generation+1;
 const text=JSON.stringify(value);
 const statements=[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'d1\' AND generation=?',[next,authority.generation]],
  [FENCE_SQL,[]],
 ];
 if(previousToken==null)statements.push(['INSERT INTO prediction_lease (name,token,expires_at,document_json) VALUES (?,?,?,?)',[name,token,Number(value?.expiresAt)||0,text]]);
 else statements.push(['UPDATE prediction_lease SET token=?, expires_at=?, document_json=? WHERE name=? AND token=?',[token,Number(value?.expiresAt)||0,text,name,previousToken]]);
 await fenced(env.DB,statements);
 await mirror(env.BUCKET,name==='writer'?WRITER_KEY:RUNNER_KEY,value);
 return token;
}

export async function saveMutable(env,key,value){
 const kind=predictionMutableKey(key);
 if(!kind)return {handled:false};
 const authority=await readPredictionAuthority(env?.DB);
 if(authority.version===7&&authority.mode==='r2'){await claim(env.DB,authority.generation);return {handled:false,claimed:true};}
 if(authority.mode!=='d1')return {handled:false};
 if(kind==='fingerprint')await saveFingerprint(env,filmIdFrom(key,'fingerprint'),value,authority);
 else if(kind==='predictions')await savePredictions(env,filmIdFrom(key,'predictions'),value,authority);
 else if(kind==='profile')await saveProfile(env,value,authority);
 else if(kind==='queue')await saveQueueDocument(env,value,authority);
 else if(kind==='run'||kind==='latest')await saveRun(env,value,authority);
 else if(kind==='runner'||kind==='writer'){const name=leaseName(kind);const existing=await loadLease(env.DB,name);await saveLease(env,name,value,existing?.token??null,authority);}
 else return {handled:false};
 return {handled:true};
}

export async function openQueue(env){
 const authority=await readPredictionAuthority(env?.DB);
 if(authority.mode==='d1')return {mode:'d1',version:7,generation:authority.generation,queueGeneration:authority.queueGeneration,queue:await loadQueue(env.DB),object:null};
 const object=await env.BUCKET.get(QUEUE_KEY);
 return {mode:'r2',version:authority.version,generation:authority.generation,object,queue:object?await object.json():null};
}
export async function writeQueue(env,head,queue){
 if(head.mode==='d1'){
  try{await saveQueueDocument(env,queue,head);return {etag:'d1'};}
  catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 if(head.version===7){
  try{await claim(env.DB,head.generation);}catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 return env.BUCKET.put(QUEUE_KEY,JSON.stringify(queue),{httpMetadata:{contentType:'application/json'},onlyIf:head.object?{etagMatches:head.object.etag}:{etagDoesNotMatch:'*'}});
}
export async function openLease(env,key){
 const name=key===WRITER_KEY?'writer':'runner';
 const authority=await readPredictionAuthority(env?.DB);
 if(authority.mode==='d1'){const lease=await loadLease(env.DB,name);return {mode:'d1',version:7,generation:authority.generation,name,token:lease?.token??null,value:lease?.value??null,object:null};}
 const object=await env.BUCKET.get(key);
 return {mode:'r2',version:authority.version,generation:authority.generation,name,object,value:object?await object.json():null,token:null};
}
export async function writeLease(env,head,value){
 if(head.mode==='d1'){
  try{const token=await saveLease(env,head.name,value,head.token,head);return {etag:token};}
  catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 if(head.version===7){
  try{await claim(env.DB,head.generation);}catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 return env.BUCKET.put(head.name==='writer'?WRITER_KEY:RUNNER_KEY,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:head.object?{etagMatches:head.object.etag}:{etagDoesNotMatch:'*'}});
}
export async function openProfile(env){
 const authority=await readPredictionAuthority(env?.DB);
 if(authority.mode==='d1')return {mode:'d1',version:7,generation:authority.generation,profileGeneration:authority.profileGeneration,value:await loadProfile(env),object:null};
 const object=await env.BUCKET.get(PROFILE_KEY);
 return {mode:'r2',version:authority.version,generation:authority.generation,object,value:object?await object.json():null};
}

export async function overlayIndex(env,index){
 const db=env?.DB??env;
 const authority=await readPredictionAuthority(db);
 if(authority.mode!=='d1')return index;
 const [fingerprints,pointers]=await Promise.all([
  many(db,'SELECT film_id AS filmId, features_json AS features FROM prediction_fingerprint'),
  many(db,'SELECT film_id AS filmId, display_json AS display FROM prediction_pointer'),
 ]);
 const next={...(index||{})};
 const byFilm=new Map();
 for(const row of fingerprints){
  let features;try{features=JSON.parse(row.features);}catch{throw failed('prediction_domain_unavailable');}
  byFilm.set(row.filmId,{...(byFilm.get(row.filmId)||{}),features});
 }
 for(const row of pointers){
  let display;try{display=JSON.parse(row.display);}catch{throw failed('prediction_domain_unavailable');}
  byFilm.set(row.filmId,{...(byFilm.get(row.filmId)||{}),display});
 }
 const ids=new Set([...Object.keys(next),...byFilm.keys()]);
 for(const filmId of ids){
  const item={...(next[filmId]||{})};
  delete item.prediction;delete item.fingerprint;delete item.fingerprintHash;delete item.impactFeatures;
  const owned=byFilm.get(filmId);
  if(owned?.features){
   const features=owned.features;
   item.fingerprintHash=features.fingerprintHash;
   item.fingerprint={plotMechanics:features.plotMechanics,moodLabels:features.moodLabels,execution:features.execution,fingerprintHash:features.fingerprintHash};
   item.impactFeatures={fingerprintHash:features.fingerprintHash,fingerprintSchemaVersion:features.fingerprintSchemaVersion??null,fingerprintPromptVersion:features.fingerprintPromptVersion??null,invalidatedAt:features.invalidatedAt||null,plotMechanics:features.plotMechanics,execution:features.execution};
  }
  if(owned?.display)item.prediction=owned.display;
  next[filmId]=item;
 }
 return next;
}

export async function importPredictionDomain(db,bucket,snapshot){
 const authority=await readPredictionAuthority(db);
 if(authority.version!==7||authority.mode!=='d1'&&authority.mode!=='r2')throw failed('prediction_domain_not_ready');
 if(authority.mode!=='r2'||authority.generation!==0||authority.queueGeneration!==0||authority.profileGeneration!==0)throw failed('prediction_domain_not_ready');
 const filmsBefore=await one(db,'SELECT COUNT(*) AS n FROM film');
 const statements=[[ 'UPDATE prediction_domain_authority SET generation=1 WHERE id=1 AND mode=\'r2\' AND generation=0 AND queue_generation=0 AND profile_generation=0',[]],[FENCE_SQL,[]]];
 if(snapshot?.profile){
  const value=snapshot.profile;
  const key=profileKey(value.version);
  const body=await readBody(bucket,key);
  if(body.profileHash!==value.profileHash||body.version!==value.version)throw failed('prediction_domain_body_mismatch');
  statements.push(['INSERT INTO prediction_profile (version,profile_hash,active,created_at,r2_key,content_sha256,lineage_json) VALUES (?,?,1,?,?,?,?)',[value.version,value.profileHash,value.updatedAt,key,await sha256(body),value.lineage===undefined?null:JSON.stringify(value.lineage)]]);
 }
 for(const item of snapshot?.fingerprints||[]){
  const key=fingerprintKey(item.filmId,item.record.fingerprintHash);
  const body=await readBody(bucket,key);
  if(body.fingerprintHash!==item.record.fingerprintHash)throw failed('prediction_domain_body_mismatch');
  const features=featuresOf(item.record);
  statements.push(['INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (?,?,?,?,?,?,?,?,?)',[item.filmId,item.record.fingerprintHash,features.fingerprintSchemaVersion??0,features.fingerprintPromptVersion,features.generatedAt,features.invalidatedAt,key,await sha256(body),JSON.stringify(features)]]);
 }
 for(const item of snapshot?.predictions||[]){
  const history=Array.isArray(item.bundle?.history)?item.bundle.history:[];
  if(history.length>PREDICTION_HISTORY_LIMIT)throw failed('prediction_domain_budget');
  const records=[...(item.bundle?.current?[item.bundle.current]:[]),...history];
  for(const record of records){
   if(typeof record?.contentSha256!=='string'||typeof record?.r2Key!=='string')throw failed('prediction_domain_unlinked');
   await verified(bucket,record.r2Key,record.contentSha256);
  }
  if(item.bundle?.current){
   const columns=pointerColumns(item.bundle.current);
   if(columns[8]==null)throw failed('prediction_domain_unlinked');
   statements.push(['INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[item.filmId,...columns,JSON.stringify(displayOf(item.bundle.current))]]);
  }
  for(const record of history){
   if(typeof record?.replacedAt!=='string'||!record.replacedAt)throw failed('prediction_domain_unlinked');
   statements.push(['INSERT INTO prediction_lineage (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,r2_key,content_sha256,display_json) VALUES (?,?,?,?,?,?,?,?)',[item.filmId,record.replacedAt,record.predictedRating??null,record.tasteProfileVersion??null,record.fingerprintHash??null,record.r2Key,record.contentSha256,JSON.stringify({...displayOf(record),replacedAt:record.replacedAt})]]);
  }
 }
 if(snapshot?.queue){
  const text=JSON.stringify(snapshot.queue);
  if(text.length>PREDICTION_QUEUE_CHARS)throw failed('prediction_domain_budget');
  statements.push(['INSERT INTO prediction_queue (id,document_json,generation) VALUES (1,?,0)',[text]]);
  statements.push(['UPDATE prediction_domain_authority SET queue_generation=0 WHERE id=1',[]]);
 }
 for(const run of snapshot?.runs||[])statements.push(['INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES (?,0,?,?)',[run.runId,run.updatedAt||run.createdAt,JSON.stringify(run)]]);
 if(snapshot?.latestRunId)statements.push(['UPDATE prediction_run SET latest=CASE WHEN run_id=? THEN 1 ELSE 0 END',[snapshot.latestRunId]]);
 await fenced(db,statements);
 const filmsAfter=await one(db,'SELECT COUNT(*) AS n FROM film');
 if(Number(filmsBefore?.n)!==Number(filmsAfter?.n))throw failed('prediction_domain_phantom_film');
 const now=await readPredictionAuthority(db);
 if(now.mode!=='r2')throw failed('prediction_domain_cas');
 return now;
}
export async function activatePredictionDomain(db,expected){
 const authority=await readPredictionAuthority(db);
 if(authority.mode!=='r2'||authority.generation!==expected?.generation||authority.queueGeneration!==expected?.queueGeneration||authority.profileGeneration!==expected?.profileGeneration)throw failed('prediction_domain_cas');
 await fenced(db,[
  ['UPDATE prediction_domain_authority SET mode=\'d1\' WHERE id=1 AND mode=\'r2\' AND generation=? AND queue_generation=? AND profile_generation=?',[authority.generation,authority.queueGeneration,authority.profileGeneration]],
  [FENCE_SQL,[]],
 ]);
 const now=await readPredictionAuthority(db);
 if(now.mode!=='d1')throw failed('prediction_domain_cas');
 return now;
}
export async function revertPredictionDomain(db,expected){
 const authority=await readPredictionAuthority(db);
 if(authority.mode!=='d1'||authority.generation!==expected?.generation||authority.queueGeneration!==expected?.queueGeneration||authority.profileGeneration!==expected?.profileGeneration)throw failed('prediction_domain_cas');
 await fenced(db,[
  ['UPDATE prediction_domain_authority SET mode=\'r2\' WHERE id=1 AND mode=\'d1\' AND generation=? AND queue_generation=? AND profile_generation=?',[authority.generation,authority.queueGeneration,authority.profileGeneration]],
  [FENCE_SQL,[]],
 ]);
 return readPredictionAuthority(db);
}
