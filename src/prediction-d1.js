// ADR 0078. Mutable prediction state is owned by D1 only after its own marker is switched.
// Schema versions before 7 keep the R2 objects and do not write these tables. Version 7 or any
// later additive version requires these tables and a valid marker, and fails closed when either
// is missing or the binding does not answer. Mode d1 reads and writes these tables and does not
// fall back to the objects. Immutable bodies stay in R2 and are verified before a pointer moves.
// This module does not import. The Worker bundle wraps it in a scope. It does not insert a film row.

export const PREDICTION_CONTRACT=7;
export const PREDICTION_HISTORY_LIMIT=80;
export const PREDICTION_QUEUE_CHARS=900000;
export const PREDICTION_INDEX_CHUNK=80;
export const PREDICTION_INDEX_LIMIT=5000;
export const PREDICTION_BIND_LIMIT=100;
export const PREDICTION_PRUNE_CHUNK=80;
export const PREDICTION_STATEMENT_BYTES=100*1024;
export const PREDICTION_QUEUE_CHUNK=40000;
const FENCE_SQL='UPDATE prediction_domain_cas SET ok=changes() WHERE id=1';
const QUEUE_KEY='enrichment/prediction-queue.json';
const PROFILE_KEY='enrichment/profile/current.json';
const RUNNER_KEY='enrichment/runner-lease.json';
const WRITER_KEY='enrichment/writer-lease.json';
const LATEST_KEY='enrichment/latest-run.json';
const TABLES=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent'];
const PRUNE_COLUMN={prediction_fingerprint:'film_id',prediction_pointer:'film_id',prediction_lineage:'film_id',prediction_run:'run_id'};
const encoder=new TextEncoder();

function failed(code,cause){const error=new Error(code);error.code=code;if(cause)error.cause=cause;return error;}
function binding(db){return typeof db?.prepare==='function';}
function literalBytes(value){
 if(value==null)return 4;
 if(typeof value==='number'||typeof value==='boolean')return String(value).length;
 const text=String(value);
 return 2+encoder.encode(text).length+(text.split("'").length-1);
}
function assertStatements(statements){
 for(const [sql,params=[]] of statements){
  if(params.length>PREDICTION_BIND_LIMIT)throw failed('prediction_domain_budget');
  const size=encoder.encode(sql).length+params.reduce((sum,value)=>sum+literalBytes(value),0);
  if(size>PREDICTION_STATEMENT_BYTES)throw failed('prediction_domain_budget');
 }
}
function rethrowFence(error){
 if(error?.name==='OperatorStop'||error?.kind==='write_uncertain'||error?.kind==='batch_too_large')throw error;
 if(error?.code==='prediction_domain_cas'||error?.code==='prediction_domain_budget'||error?.code==='prediction_domain_busy')throw error;
 const message=String(error?.message||error);
 if(/CHECK constraint failed|UNIQUE constraint failed/i.test(message))throw failed('prediction_domain_cas',error);
 throw failed('prediction_domain_unavailable',error);
}
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
 assertStatements(statements);
 let prepared;
 try{prepared=statements.map(([sql,params])=>db.prepare(sql).bind(...params));}
 catch(error){rethrowFence(error);}
 try{await db.batch(prepared);}
 catch(error){rethrowFence(error);}
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

function idleAuthority(version,bindingPresent){
 return {mode:'r2',tables:false,version,ready:false,binding:bindingPresent,generation:0,queueGeneration:0,profileGeneration:0,writes:null};
}
export async function readPredictionAuthority(db,env){
 // A local caller that omits the binding and does not set PREDICTION_DB_REQUIRED stays on the objects.
 // The deployed Worker sets that variable, so a missing binding fails closed and does not read R2.
 // A binding that does not answer, or a version of 7 or newer with a partial domain, fails closed.
 if(db==null){
  if(env?.PREDICTION_DB_REQUIRED==='on')throw failed('prediction_domain_unavailable');
  return idleAuthority(null,false);
 }
 let version;
 try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error)))return idleAuthority(null,true);
  throw failed('prediction_domain_unavailable',error);
 }
 if(version==null||Number(version)<PREDICTION_CONTRACT)return idleAuthority(version,true);
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")")).map(row=>row.name);}
 catch(error){throw failed('prediction_domain_unavailable',error);}
 if(!TABLES.every(name=>names.includes(name)))throw failed('prediction_domain_unavailable');
 let row;
 try{row=await one(db,'SELECT mode, generation, queue_generation AS queueGeneration, profile_generation AS profileGeneration, writes FROM prediction_domain_authority WHERE id=1');}
 catch(error){throw failed('prediction_domain_unavailable',error);}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held'))throw failed('prediction_domain_unavailable');
 return {mode:row.mode,tables:true,version:Number(version),ready:row.mode==='d1',binding:true,generation:Number(row.generation),queueGeneration:Number(row.queueGeneration),profileGeneration:Number(row.profileGeneration),writes:row.writes};
}

export async function reservePredictionWrite(env,key,generation){
 const authority=await readPredictionAuthority(env?.DB,env);
 if(!authority.tables||authority.mode!=='r2')throw failed('prediction_domain_not_ready');
 if(authority.generation!==generation)throw failed('prediction_domain_cas');
 const token=crypto.randomUUID();
 const next=generation+1;
 await fenced(env.DB,[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'r2\' AND writes=\'open\' AND generation=?',[next,generation]],
  [FENCE_SQL,[]],
  ['INSERT INTO prediction_domain_intent (key, token, generation) VALUES (?,?,?)',[key,token,next]],
 ]);
 return {token,generation:next};
}
export async function completePredictionWrite(env,key,token){
 if(!token)return;
 const db=env?.DB??env;
 await fenced(db,[
  ['DELETE FROM prediction_domain_intent WHERE key=? AND token=?',[key,token]],
  [FENCE_SQL,[]],
 ]);
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

function queuePieces(text){
 const pieces=[];
 let start=0;
 while(start<text.length){
  let end=Math.min(text.length,start+PREDICTION_QUEUE_CHUNK);
  while(end>start&&literalBytes(text.slice(start,end))+160>PREDICTION_STATEMENT_BYTES)end=start+Math.max(1,Math.floor((end-start)/2));
  if(literalBytes(text.slice(start,end))+160>PREDICTION_STATEMENT_BYTES)throw failed('prediction_domain_budget');
  pieces.push(text.slice(start,end));
  start=end;
 }
 return pieces;
}
function queueStatements(text,generation){
 if(text.length>PREDICTION_QUEUE_CHARS)throw failed('prediction_domain_budget');
 const pieces=queuePieces(text);
 return [['DELETE FROM prediction_queue',[]],...pieces.map((chunk,seq)=>['INSERT INTO prediction_queue (seq, chunk_text, generation) VALUES (?,?,?)',[seq,chunk,generation]])];
}
async function loadQueue(db){
 const rows=await many(db,'SELECT chunk_text AS chunk FROM prediction_queue ORDER BY seq');
 if(!rows.length)return null;
 try{return JSON.parse(rows.map(row=>row.chunk).join(''));}catch{throw failed('prediction_domain_unavailable');}
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
 const authority=await readPredictionAuthority(env?.DB,env);
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
  ...queueStatements(text,queueNext),
 ]);
 await mirror(env.BUCKET,QUEUE_KEY,queue);
 return queueNext;
}
async function saveRun(env,run,authority,elect){
 const runId=run?.runId;
 if(typeof runId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(runId))throw failed('prediction_domain_unavailable');
 const next=authority.generation+1;
 const text=JSON.stringify(run);
 const at=run.updatedAt||run.completedAt||run.createdAt||new Date().toISOString();
 const statements=[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'d1\' AND generation=?',[next,authority.generation]],
  [FENCE_SQL,[]],
 ];
 if(elect){
  statements.push(['UPDATE prediction_run SET latest=0 WHERE latest=1',[]]);
  statements.push(['INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES (?,1,?,?) ON CONFLICT(run_id) DO UPDATE SET latest=1, updated_at=excluded.updated_at, document_json=excluded.document_json',[runId,at,text]]);
 }else statements.push(['INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES (?,0,?,?) ON CONFLICT(run_id) DO UPDATE SET updated_at=excluded.updated_at, document_json=excluded.document_json',[runId,at,text]]);
 await fenced(env.DB,statements);
 await mirror(env.BUCKET,'enrichment/runs/'+runId+'.json',run);
 if(elect)await mirror(env.BUCKET,LATEST_KEY,run);
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
 const authority=await readPredictionAuthority(env?.DB,env);
 if(authority.tables&&authority.mode==='r2'){const reserved=await reservePredictionWrite(env,key,authority.generation);return {handled:false,claimed:true,token:reserved.token};}
 if(authority.mode!=='d1')return {handled:false};
 if(kind==='fingerprint')await saveFingerprint(env,filmIdFrom(key,'fingerprint'),value,authority);
 else if(kind==='predictions')await savePredictions(env,filmIdFrom(key,'predictions'),value,authority);
 else if(kind==='profile')await saveProfile(env,value,authority);
 else if(kind==='queue')await saveQueueDocument(env,value,authority);
 else if(kind==='run')await saveRun(env,value,authority,false);
 else if(kind==='latest')await saveRun(env,value,authority,true);
 else if(kind==='runner'||kind==='writer'){const name=leaseName(kind);const existing=await loadLease(env.DB,name);await saveLease(env,name,value,existing?.token??null,authority);}
 else return {handled:false};
 return {handled:true};
}

export async function openQueue(env){
 const authority=await readPredictionAuthority(env?.DB,env);
 if(authority.mode==='d1')return {mode:'d1',version:authority.version,generation:authority.generation,queueGeneration:authority.queueGeneration,queue:await loadQueue(env.DB),object:null};
 const object=await env.BUCKET.get(QUEUE_KEY);
 return {mode:'r2',version:authority.version,generation:authority.generation,object,queue:object?await object.json():null};
}
export async function writeQueue(env,head,queue){
 if(head.mode==='d1'){
  try{await saveQueueDocument(env,queue,head);return {etag:'d1'};}
  catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 let token=null;
 if(Number(head.version)>=PREDICTION_CONTRACT){
  try{token=(await reservePredictionWrite(env,QUEUE_KEY,head.generation)).token;}catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 try{return await env.BUCKET.put(QUEUE_KEY,JSON.stringify(queue),{httpMetadata:{contentType:'application/json'},onlyIf:head.object?{etagMatches:head.object.etag}:{etagDoesNotMatch:'*'}});}
 finally{if(token)await completePredictionWrite(env,QUEUE_KEY,token);}
}
export async function openLease(env,key){
 const name=key===WRITER_KEY?'writer':'runner';
 const authority=await readPredictionAuthority(env?.DB,env);
 if(authority.mode==='d1'){const lease=await loadLease(env.DB,name);return {mode:'d1',version:authority.version,generation:authority.generation,name,token:lease?.token??null,value:lease?.value??null,object:null};}
 const object=await env.BUCKET.get(key);
 return {mode:'r2',version:authority.version,generation:authority.generation,name,object,value:object?await object.json():null,token:null};
}
export async function writeLease(env,head,value){
 if(head.mode==='d1'){
  try{const token=await saveLease(env,head.name,value,head.token,head);return {etag:token};}
  catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 const key=head.name==='writer'?WRITER_KEY:RUNNER_KEY;
 let token=null;
 if(Number(head.version)>=PREDICTION_CONTRACT){
  try{token=(await reservePredictionWrite(env,key,head.generation)).token;}catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 try{return await env.BUCKET.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:head.object?{etagMatches:head.object.etag}:{etagDoesNotMatch:'*'}});}
 finally{if(token)await completePredictionWrite(env,key,token);}
}
export async function openProfile(env){
 const authority=await readPredictionAuthority(env?.DB,env);
 if(authority.mode==='d1')return {mode:'d1',version:authority.version,generation:authority.generation,profileGeneration:authority.profileGeneration,value:await loadProfile(env),object:null};
 const object=await env.BUCKET.get(PROFILE_KEY);
 return {mode:'r2',version:authority.version,generation:authority.generation,object,value:object?await object.json():null};
}

export async function overlayIndex(env,index,moodFacet){
 const direct=!!env&&typeof env.prepare==='function'&&env.BUCKET==null;
 const db=direct?env:(env?.DB??null);
 const authority=await readPredictionAuthority(db,direct?undefined:env);
 if(authority.mode!=='d1')return index;
 const next={...(index||{})};
 const ids=Object.keys(next);
 if(ids.length>PREDICTION_INDEX_LIMIT)throw failed('prediction_domain_budget');
 const byFilm=new Map();
 for(let start=0;start<ids.length;start+=PREDICTION_INDEX_CHUNK){
  const chunk=ids.slice(start,start+PREDICTION_INDEX_CHUNK);
  const marks=chunk.map(()=>'?').join(',');
  const [fingerprints,pointers]=await Promise.all([
   many(db,'SELECT film_id AS filmId, features_json AS features FROM prediction_fingerprint WHERE film_id IN ('+marks+')',chunk),
   many(db,'SELECT film_id AS filmId, display_json AS display FROM prediction_pointer WHERE film_id IN ('+marks+')',chunk),
  ]);
  for(const row of fingerprints){
   let features;try{features=JSON.parse(row.features);}catch{throw failed('prediction_domain_unavailable');}
   byFilm.set(row.filmId,{...(byFilm.get(row.filmId)||{}),features});
  }
  for(const row of pointers){
   let display;try{display=JSON.parse(row.display);}catch{throw failed('prediction_domain_unavailable');}
   byFilm.set(row.filmId,{...(byFilm.get(row.filmId)||{}),display});
  }
 }
 for(const filmId of ids){
  const item={...(next[filmId]||{})};
  delete item.prediction;delete item.fingerprint;delete item.fingerprintHash;delete item.impactFeatures;delete item.moodFacet;
  const owned=byFilm.get(filmId);
  if(owned?.features){
   const features=owned.features;
   item.fingerprintHash=features.fingerprintHash;
   item.fingerprint={plotMechanics:features.plotMechanics,moodLabels:features.moodLabels,execution:features.execution,fingerprintHash:features.fingerprintHash};
   item.impactFeatures={fingerprintHash:features.fingerprintHash,fingerprintSchemaVersion:features.fingerprintSchemaVersion??null,fingerprintPromptVersion:features.fingerprintPromptVersion??null,invalidatedAt:features.invalidatedAt||null,plotMechanics:features.plotMechanics,execution:features.execution};
  }
  if(owned?.display)item.prediction=owned.display;
  if(typeof moodFacet==='function'&&(item.fingerprint||item.prediction))item.moodFacet=moodFacet(item.fingerprint,item.prediction);
  next[filmId]=item;
 }
 return next;
}

function sameFence(authority,fence){
 return !!authority?.tables&&authority.mode==='r2'&&authority.generation===fence?.generation&&authority.queueGeneration===fence?.queueGeneration&&authority.profileGeneration===fence?.profileGeneration;
}
function leasesBusy(leases,now){
 return [leases?.runner,leases?.writer].some(lease=>lease&&Number(lease.expiresAt)>now);
}
function writerHold(fence){
 return ['UPDATE prediction_domain_authority SET writes=\'held\' WHERE id=1 AND mode=\'r2\' AND writes IN (\'open\',\'held\') AND generation=? AND queue_generation=? AND profile_generation=?',[fence.generation,fence.queueGeneration,fence.profileGeneration]];
}
function unitHold(fence){
 return ['UPDATE prediction_domain_authority SET generation=generation WHERE id=1 AND mode=\'r2\' AND writes=\'held\' AND generation=? AND queue_generation=? AND profile_generation=?',[fence.generation,fence.queueGeneration,fence.profileGeneration]];
}
async function intentCount(db){
 return Number((await one(db,'SELECT COUNT(*) AS n FROM prediction_domain_intent'))?.n||0);
}
async function pruneStale(db,fence,table,ids,onCommit){
 const column=PRUNE_COLUMN[table];
 if(!column)throw failed('prediction_domain_unavailable');
 const keep=new Set(ids);
 let after='';
 for(;;){
  const page=await many(db,'SELECT '+column+' AS id FROM '+table+' WHERE '+column+' > ? ORDER BY '+column+' LIMIT '+PREDICTION_PRUNE_CHUNK,[after]);
  if(!page.length)return;
  after=page[page.length-1].id;
  const stale=page.map(row=>row.id).filter(id=>!keep.has(id));
  if(!stale.length)continue;
  await fenced(db,[unitHold(fence),[FENCE_SQL,[]],['DELETE FROM '+table+' WHERE '+column+' IN ('+stale.map(()=>'?').join(',')+')',stale]]);
  onCommit();
 }
}
async function predictionStatements(bucket,item){
 const history=Array.isArray(item.bundle?.history)?item.bundle.history:[];
 if(history.length>PREDICTION_HISTORY_LIMIT)throw failed('prediction_domain_budget');
 const records=[...(item.bundle?.current?[item.bundle.current]:[]),...history];
 for(const record of records){
  if(typeof record?.contentSha256!=='string'||typeof record?.r2Key!=='string')throw failed('prediction_domain_unlinked');
  await verified(bucket,record.r2Key,record.contentSha256);
 }
 const statements=[
  ['DELETE FROM prediction_pointer WHERE film_id=?',[item.filmId]],
  ['DELETE FROM prediction_lineage WHERE film_id=?',[item.filmId]],
 ];
 if(item.bundle?.current){
  const columns=pointerColumns(item.bundle.current);
  if(columns[8]==null)throw failed('prediction_domain_unlinked');
  statements.push(['INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[item.filmId,...columns,JSON.stringify(displayOf(item.bundle.current))]]);
 }
 for(const record of history){
  if(typeof record?.replacedAt!=='string'||!record.replacedAt)throw failed('prediction_domain_unlinked');
  statements.push(['INSERT INTO prediction_lineage (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,r2_key,content_sha256,display_json) VALUES (?,?,?,?,?,?,?,?)',[item.filmId,record.replacedAt,record.predictedRating??null,record.tasteProfileVersion??null,record.fingerprintHash??null,record.r2Key,record.contentSha256,JSON.stringify({...displayOf(record),replacedAt:record.replacedAt})]]);
 }
 return statements;
}
export async function predictionParity(db){
 const fingerprints=await many(db,'SELECT film_id AS filmId, fingerprint_hash AS fingerprintHash FROM prediction_fingerprint ORDER BY film_id');
 const pointers=await many(db,'SELECT film_id AS filmId, content_sha256 AS contentSha256 FROM prediction_pointer ORDER BY film_id');
 const lineage=await one(db,'SELECT COUNT(*) AS n FROM prediction_lineage');
 const queue=await loadQueue(db);
 const profile=await one(db,'SELECT version, profile_hash AS profileHash FROM prediction_profile WHERE active=1');
 const latest=await one(db,'SELECT run_id AS runId FROM prediction_run WHERE latest=1');
 const runs=await one(db,'SELECT COUNT(*) AS n FROM prediction_run');
 const leases=await one(db,'SELECT COUNT(*) AS n FROM prediction_lease');
 return {
  fingerprints:fingerprints.map(row=>row.filmId+'\n'+row.fingerprintHash),
  pointers:pointers.map(row=>row.filmId+'\n'+row.contentSha256),
  lineage:Number(lineage?.n||0),
  queue:queue==null?null:JSON.stringify(queue),
  profile:profile?profile.version+'\n'+profile.profileHash:null,
  latestRunId:latest?.runId??null,
  runs:Number(runs?.n||0),
  leases:Number(leases?.n||0),
 };
}
export function snapshotParity(snapshot){
 return expectedParity(snapshot);
}
function expectedParity(snapshot){
 const fingerprints=(snapshot?.fingerprints||[]).map(item=>item.filmId+'\n'+item.record.fingerprintHash).sort();
 const pointers=(snapshot?.predictions||[]).filter(item=>item.bundle?.current).map(item=>item.filmId+'\n'+item.bundle.current.contentSha256).sort();
 const lineage=(snapshot?.predictions||[]).reduce((sum,item)=>sum+(Array.isArray(item.bundle?.history)?item.bundle.history.length:0),0);
 const profile=snapshot?.profile?snapshot.profile.version+'\n'+snapshot.profile.profileHash:null;
 return {fingerprints,pointers,lineage,queue:snapshot?.queue==null?null:JSON.stringify(snapshot.queue),profile,latestRunId:snapshot?.latestRunId??null,runs:(snapshot?.runs||[]).length,leases:0};
}
function parityAgrees(live,expected){
 const normalized=value=>({...value,fingerprints:[...value.fingerprints].sort(),pointers:[...value.pointers].sort()});
 return JSON.stringify(normalized(live))===JSON.stringify(normalized(expected));
}
export async function importPredictionDomain(db,bucket,snapshot,options={}){
 const authority=await readPredictionAuthority(db);
 if(!authority.tables||authority.mode!=='r2')throw failed('prediction_domain_not_ready');
 const fence={generation:options.fence?.generation??authority.generation,queueGeneration:options.fence?.queueGeneration??authority.queueGeneration,profileGeneration:options.fence?.profileGeneration??authority.profileGeneration};
 if(!sameFence(authority,fence))throw failed('prediction_domain_cas');
 const now=options.now??Date.now();
 if(leasesBusy(options.leases??snapshot?.leases,now))throw failed('prediction_domain_busy');
 let committed=0;
 let source=snapshot;
 try{
  await fenced(db,[writerHold(fence),[FENCE_SQL,[]]]);
  committed++;
  if(await intentCount(db))throw failed('prediction_domain_busy');
  const held=await readPredictionAuthority(db);
  if(!sameFence(held,fence)||held.writes!=='held')throw failed('prediction_domain_cas');
  if(options.afterHold){
   source=await options.afterHold();
   if(leasesBusy(source?.leases,now))throw failed('prediction_domain_busy');
  }
  const filmsBefore=await one(db,'SELECT COUNT(*) AS n FROM film');
  const units=[];
  if(source&&Object.hasOwn(source,'profile')){
   if(source.profile)units.push({kind:'profile',value:source.profile});
   else units.push({kind:'clear-profile'});
  }else if(source?.profile)units.push({kind:'profile',value:source.profile});
  if(Array.isArray(source?.fingerprints)){
   for(const item of source.fingerprints)units.push({kind:'fingerprint',item});
   units.push({kind:'prune',table:'prediction_fingerprint',ids:source.fingerprints.map(item=>item.filmId)});
  }
  if(Array.isArray(source?.predictions)){
   for(const item of source.predictions)units.push({kind:'prediction',item});
   units.push({kind:'prune',table:'prediction_pointer',ids:source.predictions.filter(item=>item.bundle?.current).map(item=>item.filmId)});
   units.push({kind:'prune',table:'prediction_lineage',ids:[...new Set(source.predictions.map(item=>item.filmId))]});
  }
  if(source&&Object.hasOwn(source,'queue')){
   if(source.queue)units.push({kind:'queue',value:source.queue});
   else units.push({kind:'clear-queue'});
  }else if(source?.queue)units.push({kind:'queue',value:source.queue});
  if(Array.isArray(source?.runs)){
   for(const run of source.runs)units.push({kind:'run',run});
   units.push({kind:'prune',table:'prediction_run',ids:source.runs.map(run=>run.runId)});
  }
  if(source?.latestRunId)units.push({kind:'latest',runId:source.latestRunId});
  units.push({kind:'leases'});
  for(const unit of units){
   const current=await readPredictionAuthority(db);
   if(!sameFence(current,fence)||current.writes!=='held')throw failed('prediction_domain_cas');
   if(unit.kind==='prune'){await pruneStale(db,fence,unit.table,unit.ids,()=>{committed++;});continue;}
   let body=[];
   if(unit.kind==='profile'){
    const value=unit.value;
    const key=profileKey(value.version);
    const stored=await readBody(bucket,key);
    if(stored.profileHash!==value.profileHash||stored.version!==value.version)throw failed('prediction_domain_body_mismatch');
    body=[['UPDATE prediction_profile SET active=0 WHERE active=1',[]],['INSERT INTO prediction_profile (version,profile_hash,active,created_at,r2_key,content_sha256,lineage_json) VALUES (?,?,1,?,?,?,?) ON CONFLICT(version) DO UPDATE SET profile_hash=excluded.profile_hash,active=1,created_at=excluded.created_at,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,lineage_json=excluded.lineage_json',[value.version,value.profileHash,value.updatedAt,key,await sha256(stored),value.lineage===undefined?null:JSON.stringify(value.lineage)]]];
   }else if(unit.kind==='fingerprint'){
    const key=fingerprintKey(unit.item.filmId,unit.item.record.fingerprintHash);
    const stored=await readBody(bucket,key);
    if(stored.fingerprintHash!==unit.item.record.fingerprintHash)throw failed('prediction_domain_body_mismatch');
    const features=featuresOf(unit.item.record);
    body=[['INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET fingerprint_hash=excluded.fingerprint_hash,schema_version=excluded.schema_version,prompt_version=excluded.prompt_version,generated_at=excluded.generated_at,invalidated_at=excluded.invalidated_at,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,features_json=excluded.features_json',[unit.item.filmId,unit.item.record.fingerprintHash,features.fingerprintSchemaVersion??0,features.fingerprintPromptVersion,features.generatedAt,features.invalidatedAt,key,await sha256(stored),JSON.stringify(features)]]];
   }else if(unit.kind==='prediction')body=await predictionStatements(bucket,unit.item);
   else if(unit.kind==='queue')body=queueStatements(JSON.stringify(unit.value),fence.queueGeneration);
   else if(unit.kind==='run')body=[['INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES (?,0,?,?) ON CONFLICT(run_id) DO UPDATE SET updated_at=excluded.updated_at, document_json=excluded.document_json',[unit.run.runId,unit.run.updatedAt||unit.run.createdAt,JSON.stringify(unit.run)]]];
   else if(unit.kind==='latest')body=[['UPDATE prediction_run SET latest=CASE WHEN run_id=? THEN 1 ELSE 0 END',[unit.runId]]];
   else if(unit.kind==='clear-profile')body=[['UPDATE prediction_profile SET active=0 WHERE active=1',[]]];
   else if(unit.kind==='clear-queue')body=[['DELETE FROM prediction_queue',[]]];
   else body=[['DELETE FROM prediction_lease',[]]];
   await fenced(db,[unitHold(fence),[FENCE_SQL,[]],...body]);
   committed++;
  }
  const filmsAfter=await one(db,'SELECT COUNT(*) AS n FROM film');
  if(Number(filmsBefore?.n)!==Number(filmsAfter?.n))throw failed('prediction_domain_phantom_film');
  const parity=await predictionParity(db);
  if(!parityAgrees(parity,expectedParity(source)))throw failed('prediction_domain_parity');
  const done=await readPredictionAuthority(db);
  if(!sameFence(done,fence)||done.writes!=='held')throw failed('prediction_domain_cas');
  return {...done,fence,parity,committedUnits:committed};
 }catch(error){
  if(error&&error.committedUnits==null)error.committedUnits=committed;
  throw error;
 }
}
export async function activatePredictionDomain(db,expected,options={}){
 const authority=await readPredictionAuthority(db);
 if(!sameFence(authority,expected))throw failed('prediction_domain_cas');
 const clock=options.now??Date.now();
 if(leasesBusy(options.leases,clock))throw failed('prediction_domain_busy');
 let committed=0;
 try{
  await fenced(db,[writerHold(expected),[FENCE_SQL,[]]]);
  committed++;
  if(await intentCount(db))throw failed('prediction_domain_busy');
  const held=await readPredictionAuthority(db);
  if(!sameFence(held,expected)||held.writes!=='held')throw failed('prediction_domain_cas');
  let parity=options.parity;
  if(options.afterHold){
   const fresh=await options.afterHold();
   if(leasesBusy(fresh?.leases,clock))throw failed('prediction_domain_busy');
   parity=snapshotParity(fresh);
  }
  if(parity&&!parityAgrees(await predictionParity(db),parity))throw failed('prediction_domain_parity');
  await fenced(db,[
   ['UPDATE prediction_domain_authority SET mode=\'d1\' WHERE id=1 AND mode=\'r2\' AND writes=\'held\' AND generation=? AND queue_generation=? AND profile_generation=? AND NOT EXISTS (SELECT 1 FROM prediction_domain_intent)',[expected.generation,expected.queueGeneration,expected.profileGeneration]],
   [FENCE_SQL,[]],
  ]);
  const now=await readPredictionAuthority(db);
  if(now.mode!=='d1')throw failed('prediction_domain_cas');
  return now;
 }catch(error){
  if(error&&error.committedUnits==null)error.committedUnits=committed;
  throw error;
 }
}
export async function releasePredictionWriters(db){
 const authority=await readPredictionAuthority(db);
 if(!authority.tables||authority.mode!=='r2')throw failed('prediction_domain_not_ready');
 if(await intentCount(db))throw failed('prediction_domain_busy');
 if(authority.writes==='open')return authority;
 await fenced(db,[
  ["UPDATE prediction_domain_authority SET writes='open' WHERE id=1 AND mode='r2' AND writes='held' AND NOT EXISTS (SELECT 1 FROM prediction_domain_intent)",[]],
  [FENCE_SQL,[]],
 ]);
 const now=await readPredictionAuthority(db);
 if(now.writes!=='open')throw failed('prediction_domain_cas');
 return now;
}
async function putChecked(bucket,key,value){
 const text=JSON.stringify(value);
 await bucket.put(key,text,{httpMetadata:{contentType:'application/json'}});
 const back=await objectText(bucket,key);
 if(back!==text)throw failed('prediction_domain_parity');
}
async function repairMirrors(db,bucket){
 const env={DB:db,BUCKET:bucket};
 for(const row of await many(db,'SELECT film_id AS filmId FROM prediction_fingerprint ORDER BY film_id')){
  const value=await loadFingerprint(env,row.filmId);
  if(!value)throw failed('prediction_domain_parity');
  await putChecked(bucket,'enrichment/films/'+encodeURIComponent(row.filmId)+'/fingerprint.json',value);
 }
 for(const row of await many(db,'SELECT film_id AS filmId FROM prediction_pointer ORDER BY film_id')){
  const value=await loadPredictions(env,row.filmId);
  if(!value?.current)throw failed('prediction_domain_parity');
  await putChecked(bucket,'enrichment/films/'+encodeURIComponent(row.filmId)+'/predictions.json',value);
 }
 const queue=await loadQueue(db);
 if(queue)await putChecked(bucket,QUEUE_KEY,queue);
 const profile=await loadProfile(env);
 if(profile)await putChecked(bucket,PROFILE_KEY,profile);
 for(const row of await many(db,'SELECT run_id AS runId FROM prediction_run ORDER BY run_id')){
  const value=await loadRun(db,row.runId);
  if(!value)throw failed('prediction_domain_parity');
  await putChecked(bucket,'enrichment/runs/'+row.runId+'.json',value);
 }
 const latest=await loadLatest(db);
 if(latest)await putChecked(bucket,LATEST_KEY,latest);
 for(const [name,key] of [['runner',RUNNER_KEY],['writer',WRITER_KEY]]){
  const lease=await loadLease(db,name);
  await putChecked(bucket,key,lease?.value??{expiresAt:0});
 }
}
export async function revertPredictionDomain(db,bucket,expected){
 const authority=await readPredictionAuthority(db);
 if(authority.mode!=='d1'||authority.generation!==expected?.generation||authority.queueGeneration!==expected?.queueGeneration||authority.profileGeneration!==expected?.profileGeneration)throw failed('prediction_domain_cas');
 await repairMirrors(db,bucket);
 const repaired=await readPredictionAuthority(db);
 if(repaired.mode!=='d1'||repaired.generation!==authority.generation||repaired.queueGeneration!==authority.queueGeneration||repaired.profileGeneration!==authority.profileGeneration)throw failed('prediction_domain_cas');
 await fenced(db,[
  ["UPDATE prediction_domain_authority SET mode='r2', writes='open' WHERE id=1 AND mode='d1' AND generation=? AND queue_generation=? AND profile_generation=? AND NOT EXISTS (SELECT 1 FROM prediction_domain_intent)",[authority.generation,authority.queueGeneration,authority.profileGeneration]],
  [FENCE_SQL,[]],
 ]);
 const now=await readPredictionAuthority(db);
 if(now.mode!=='r2')throw failed('prediction_domain_cas');
 return now;
}
