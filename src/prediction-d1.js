// ADR 0078. Mutable prediction state is owned by D1 only after its own marker is switched.
// Schema versions before 7 keep the R2 objects and do not write these tables. Version 7 or any
// later additive version requires these tables and a valid marker, and fails closed when either
// is missing or the binding does not answer. Mode d1 reads and writes these tables and does not
// fall back to the objects. Immutable bodies stay in R2 and are verified before a pointer moves.
// This module does not import. The Worker bundle wraps it in a scope. It does not insert a film row.

export const PREDICTION_CONTRACT=7;
// AIR-438: hands the D1 binding to the step timer's wrapper. This module is where the prediction domain reaches D1, so the one place the timer
// touches the binding is here and not in the Worker core, which holds no direct reference to it.
export function timedBinding(env,wrap){const database=env.DB;return database&&typeof database==='object'?wrap(database):null;}
export const PREDICTION_HISTORY_LIMIT=80;
export const PREDICTION_QUEUE_CHARS=900000;
export const PREDICTION_INDEX_CHUNK=80;
export const PREDICTION_INDEX_LIMIT=5000;
// The overlay reads the D1 prediction rows in keyset pages. Its cost is the number of rows, not the number of view-index keys.
export const PREDICTION_OVERLAY_PAGE=300;
export const PREDICTION_OVERLAY_ROWS=20000;
export const PREDICTION_BIND_LIMIT=100;
export const PREDICTION_PRUNE_CHUNK=80;
export const PREDICTION_STATEMENT_BYTES=100*1024;
export const PREDICTION_QUEUE_CHUNK=40000;
const FENCE_SQL='UPDATE prediction_domain_cas SET ok=changes() WHERE id=1';
// A commit guard (batch runner v2, ADR 0122): a request that holds the runner lease and the submit gate sets `env[COMMIT_GUARD]={runId,epoch,requestId}`, and every film
// commit it makes (fingerprint, prediction pointer, run record) then carries one more statement in the SAME D1 batch that commits only while the lease row still names that run,
// that epoch and that gate and has not expired. A handler whose gate was reassigned, or whose lease epoch changed, therefore commits nothing: the batch is rolled back by the
// same CHECK that fences the generation. A check before the write cannot give that guarantee (the handler can stall inside one storage call and commit later).
export const COMMIT_GUARD=Symbol.for('iptv.prediction.commitGuard');
function guardStatements(env){
 const guard=env?.[COMMIT_GUARD];
 if(!guard)return [];
 return [['UPDATE prediction_domain_cas SET ok=(SELECT count(*) FROM prediction_lease WHERE name=\'runner\' AND expires_at>? AND json_extract(document_json,\'$.runId\')=? AND json_extract(document_json,\'$.epoch\')=? AND json_extract(document_json,\'$.submitGate.requestId\')=?) WHERE id=1',[Date.now(),String(guard.runId),Number(guard.epoch),String(guard.requestId)]]];
}
const QUEUE_KEY='enrichment/prediction-queue.json';
const PROFILE_KEY='enrichment/profile/current.json';
const RUNNER_KEY='enrichment/runner-lease.json';
const WRITER_KEY='enrichment/writer-lease.json';
const LATEST_KEY='enrichment/latest-run.json';
const TABLES=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent'];
const PRUNE_COLUMN={prediction_fingerprint:'film_id',prediction_pointer:'film_id',prediction_lineage:'film_id',prediction_run:'run_id'};
const encoder=new TextEncoder();

// AIR-417. `guard` names which budget refused (queue_chars, index_limit, statement_bytes, bind_limit, history_limit, mirror_list).
// The code stays prediction_domain_budget; the guard rides on the error and in one structured log line without ids or bodies.
function failed(code,cause,guard){
 const error=new Error(code);error.code=code;if(cause)error.cause=cause;
 if(guard){error.guard=guard;try{console.warn(JSON.stringify({event:'prediction_domain_budget',guard}));}catch{/* logging never changes the outcome */}}
 return error;
}
function binding(db){return typeof db?.prepare==='function';}
function literalBytes(value){
 if(value==null)return 4;
 if(typeof value==='number'||typeof value==='boolean')return String(value).length;
 const text=String(value);
 return 2+encoder.encode(text).length+(text.split("'").length-1);
}
function assertStatements(statements){
 for(const [sql,params=[]] of statements){
  if(params.length>PREDICTION_BIND_LIMIT)throw failed('prediction_domain_budget',undefined,'bind_limit');
  const size=encoder.encode(sql).length+params.reduce((sum,value)=>sum+literalBytes(value),0);
  if(size>PREDICTION_STATEMENT_BYTES)throw failed('prediction_domain_budget',undefined,'statement_bytes');
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

function idleAuthority(version,bindingPresent,domain='absent'){
 return {mode:'r2',tables:false,domain,version,ready:false,binding:bindingPresent,generation:0,queueGeneration:0,profileGeneration:0,writes:null};
}
const AUTHORITY_TABLES_SQL="SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")";
const AUTHORITY_ROW_SQL='SELECT mode, generation, queue_generation AS queueGeneration, profile_generation AS profileGeneration, writes FROM prediction_domain_authority WHERE id=1';
// AIR-441. The schema contract, the table list and the authority marker in one batch of reads, the same three statements read in one snapshot. Returns null
// whenever the batch cannot answer (a table of the domain is missing, the binding has no batch, the answer has another shape), and the caller then
// asks them one at a time. It never reads anything the stepwise reader did not.
async function readAuthorityTogether(db){
 if(!binding(db)||typeof db.batch!=='function')return null;
 try{
  const results=await db.batch([db.prepare('SELECT version FROM schema_contract WHERE id=1').bind(),db.prepare(AUTHORITY_TABLES_SQL).bind(),db.prepare(AUTHORITY_ROW_SQL).bind()]);
  if(!Array.isArray(results)||results.length!==3||results.some(item=>!item||!Array.isArray(item.results)))return null;
  return {version:results[0].results[0]?.version??null,names:results[1].results.map(row=>row.name),row:results[2].results[0]??null};
 }catch{return null;}
}
async function readAuthorityNow(db,env){
 // A local caller that omits the binding and does not set PREDICTION_DB_REQUIRED stays on the objects.
 // The deployed Worker sets that variable. A missing binding, or a bound database with no schema
 // contract, then fails closed and does not read R2. A binding that does not answer fails closed.
 // Version 7 or newer with some but not all of these tables fails closed. None of the tables means
 // this domain is not installed: a later migration may have advanced the contract, and prediction
 // stays on the objects. Readiness is the tables and the marker, not the version number alone.
 if(db==null){
  if(env?.PREDICTION_DB_REQUIRED==='on')throw failed('prediction_domain_unavailable');
  return idleAuthority(null,false);
 }
 // One round trip answers the three questions below when the database has the whole domain; any refusal of that batch (a table missing, a binding that
 // cannot batch) falls back to asking them one at a time, which is the reading, and the classification of its failures, that this function always had.
 const together=await readAuthorityTogether(db);
 let version;
 if(together)version=together.version;
 else try{version=(await one(db,'SELECT version FROM schema_contract WHERE id=1'))?.version??null;}
 catch(error){
  if(/no such table/i.test(String(error?.message||error))){
   if(env?.PREDICTION_DB_REQUIRED==='on')throw failed('prediction_domain_unavailable');
   return idleAuthority(null,true);
  }
  throw failed('prediction_domain_unavailable',error);
 }
 if(version==null){
  if(env?.PREDICTION_DB_REQUIRED==='on')throw failed('prediction_domain_unavailable');
  return idleAuthority(null,true);
 }
 if(Number(version)<PREDICTION_CONTRACT)return idleAuthority(version,true);
 let names;
 if(together)names=together.names;
 else try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")")).map(row=>row.name);}
 catch(error){throw failed('prediction_domain_unavailable',error);}
 const present=TABLES.filter(name=>names.includes(name)).length;
 if(present===0)return idleAuthority(Number(version),true);
 if(present!==TABLES.length)throw failed('prediction_domain_unavailable');
 let row;
 if(together)row=together.row;
 else try{row=await one(db,'SELECT mode, generation, queue_generation AS queueGeneration, profile_generation AS profileGeneration, writes FROM prediction_domain_authority WHERE id=1');}
 catch(error){throw failed('prediction_domain_unavailable',error);}
 if(!row||(row.mode!=='r2'&&row.mode!=='d1')||(row.writes!=='open'&&row.writes!=='held'))throw failed('prediction_domain_unavailable');
 return {mode:row.mode,tables:true,domain:'ready',version:Number(version),ready:row.mode==='d1',binding:true,generation:Number(row.generation),queueGeneration:Number(row.queueGeneration),profileGeneration:Number(row.profileGeneration),writes:row.writes};
}

// AIR-441. One request of the runner (a next or a submit) asks for the authority marker a few dozen times: every routed read and every write begins with it.
// Inside such a request, and only there, the answer is reused until the request's own database does anything but read, and callers that ask while a
// read is in flight share it. The scope belongs to one request's database object (`scopeRequest`), never to the Worker: the next request, any
// other route, the cron tick and every script read the marker afresh. Every write still carries the generation it was read at in its own fenced
// batch, so a marker that moved in the meantime fails that write closed (`prediction_domain_cas`) instead of landing it; what a read inside the same
// request can miss is a change that happened after the marker was read and before the request's next write, for at most the length of the request.
const REQUEST_SCOPES=new WeakMap();
// A statement counts as a read only if it is a plain SELECT, one statement, with nothing before it. SQLite lets a WITH statement end in an UPDATE, INSERT or DELETE
// (with RETURNING it can be run through first() or all()), a PRAGMA can set as well as read, and a comment can hide either; every other shape, and every statement the
// scope did not prepare itself, is treated as a write and drops the held answer.
const READ_ONLY_SQL=/^select\b[^;]*;?\s*$/i;
function scopedDatabase(database,scope){
 const statements=new WeakMap();
 const forget=()=>{scope.read=null;};
 const statementOf=(statement,sql)=>{
  const reads=typeof sql==='string'&&READ_ONLY_SQL.test(sql.trimStart());
  const proxy=new Proxy(statement,{get(target,prop){
   const value=Reflect.get(target,prop,target);
   if(typeof value!=='function')return value;
   if(prop==='bind')return(...args)=>statementOf(value.apply(target,args),sql);
   if(prop==='first'||prop==='all'||prop==='raw'||prop==='run')return async(...args)=>{
    const changes=prop==='run'||!reads;
    if(changes)forget();
    try{return await value.apply(target,args);}finally{if(changes)forget();}
   };
   return value.bind(target);
  }});
  statements.set(proxy,{target:statement,reads});
  return proxy;
 };
 const proxy=new Proxy(database,{get(target,prop){
  const value=Reflect.get(target,prop,target);
  if(typeof value!=='function')return value;
  if(prop==='prepare')return sql=>statementOf(value.call(target,sql),sql);
  if(prop==='batch')return async(list,...rest)=>{
   const known=Array.isArray(list)?list.map(item=>statements.get(item)):[];
   const reads=known.length>0&&known.every(item=>item&&item.reads);
   if(!reads)forget();
   try{return await value.call(target,Array.isArray(list)?list.map((item,index)=>known[index]?known[index].target:item):list,...rest);}finally{if(!reads)forget();}
  };
  if(prop==='exec')return async(...args)=>{forget();try{return await value.apply(target,args);}finally{forget();}};
  if(prop==='withSession')return(...args)=>{const session=scopedDatabase(value.apply(target,args),scope);return session;};
  return value.bind(target);
 }});
 REQUEST_SCOPES.set(proxy,scope);
 return proxy;
}
export function scopeRequest(env){
 const database=env?.DB;
 if(!database||typeof database!=='object'||typeof database.prepare!=='function')return env;
 return {...env,DB:scopedDatabase(database,{read:null})};
}
export async function readPredictionAuthority(db,env){
 const scope=REQUEST_SCOPES.get(db);
 if(!scope)return readAuthorityNow(db,env);
 if(scope.read)return {...await scope.read};
 const reading=readAuthorityNow(db,env);
 scope.read=reading;
 reading.catch(()=>{if(scope.read===reading)scope.read=null;});
 return {...await reading};
}
export async function reservePredictionWrite(env,key,generation,bodyText){
 if(typeof bodyText!=='string')throw failed('prediction_domain_unavailable');
 const authority=await readPredictionAuthority(env?.DB,env);
 if(!authority.tables||authority.mode!=='r2')throw failed('prediction_domain_not_ready');
 if(authority.generation!==generation)throw failed('prediction_domain_cas');
 const token=crypto.randomUUID();
 const next=generation+1;
 await fenced(env.DB,[
  ['UPDATE prediction_domain_authority SET generation=? WHERE id=1 AND mode=\'r2\' AND writes=\'open\' AND generation=?',[next,generation]],
  [FENCE_SQL,[]],
  ['INSERT INTO prediction_domain_intent (key, token, generation, body_sha256) VALUES (?,?,?,?)',[key,token,next,await sha256(bodyText)]],
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
 // The Worker binding has text() and json(). The production reader returns a body stream.
 if(typeof object.text==='function')return object.text();
 if(typeof object.json==='function')return JSON.stringify(await object.json());
 if(object.body!=null)return new Response(object.body).text();
 return null;
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
 const features={fingerprintHash:value?.fingerprintHash??null,fingerprintSchemaVersion:value?.fingerprintSchemaVersion??null,fingerprintPromptVersion:value?.fingerprintPromptVersion??1,invalidatedAt:value?.invalidatedAt||null,generatedAt:value?.generatedAt||null,produced:value?.produced||null,previous:value?.previous??null,plotMechanics:Array.isArray(value?.plotMechanics)?value.plotMechanics:[],moodLabels:Array.isArray(value?.moodLabels)?value.moodLabels:[],execution:value?.execution&&typeof value.execution==='object'?value.execution:{}};
 if(value?.fields!==undefined){
  if(!Array.isArray(value.fields)||value.fields.some(field=>typeof field!=='string'))throw failed('prediction_domain_unavailable');
  features.fields=value.fields.slice();
 }
 return features;
}
function displayOf(value){
 if(!value||typeof value!=='object')return {};
 const {r2Key:_key,contentSha256:_sha,replacedAt:_at,...body}=value;
 return body;
}
export function fingerprintKey(filmId,hash){return 'enrichment/films/'+encodeURIComponent(filmId)+'/fingerprints/'+hash+'.json';}
const FINGERPRINT_PROVENANCE=new Set(['generatedAt','invalidatedAt','fingerprintPromptVersion','produced','fields','previous']);
export function fingerprintBodyFromPointer(record){
 if(!record||typeof record!=='object'||typeof record.fingerprintHash!=='string'||!record.fingerprintHash)return null;
 const body={};
 for(const [key,value] of Object.entries(record))if(!FINGERPRINT_PROVENANCE.has(key))body[key]=value;
 return body.fingerprintHash===record.fingerprintHash?body:null;
}
export async function fingerprintContentHash(value){return sha256(value);}
export async function fingerprintPointerAgrees(record){
 const body=fingerprintBodyFromPointer(record);
 if(!body)return null;
 const {fingerprintHash:_hash,...hashed}=body;
 if(await sha256(hashed)!==record.fingerprintHash)return null;
 return body;
}
export async function sameCanonical(left,right){return await sha256(left)===await sha256(right);}
function profileKey(version){return 'enrichment/profile/versions/'+version+'.json';}

function queuePieces(text){
 const pieces=[];
 let start=0;
 while(start<text.length){
  let end=Math.min(text.length,start+PREDICTION_QUEUE_CHUNK);
  while(end>start&&literalBytes(text.slice(start,end))+160>PREDICTION_STATEMENT_BYTES)end=start+Math.max(1,Math.floor((end-start)/2));
  if(literalBytes(text.slice(start,end))+160>PREDICTION_STATEMENT_BYTES)throw failed('prediction_domain_budget',undefined,'statement_bytes');
  pieces.push(text.slice(start,end));
  start=end;
 }
 return pieces;
}

// AIR-417. The stored queue text is the plain JSON document while it fits PREDICTION_QUEUE_CHARS, so every document that ever fit is
// byte-identical to before and an older Worker reads it. Only a document that would exceed the cap is stored in the `dict1` encoding:
// each film id is written once in `ids`, the lists hold integer references, and the repeated per-film `priority` and `work` values are
// written once each in `table`. loadQueue expands it back to the exact plain document, so no reader sees a different shape.
// The encoded text starts with `dict1:` so it is not valid JSON: a Worker without this support fails closed in JSON.parse
// (prediction_domain_unavailable) instead of reading the references as film ids. A compatible build must rewrite the queue as plain.
const QUEUE_ENCODING='dict1';
const QUEUE_PREFIX=QUEUE_ENCODING+':';
const QUEUE_LISTS=['pending','hotPending','coldPending'];
const QUEUE_MAPS=['priority','work'];
const isPlainObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function encodeQueueDocument(plain){
 const doc=JSON.parse(plain);
 if(!isPlainObject(doc)||Object.hasOwn(doc,'$queueEncoding'))throw failed('prediction_domain_budget',undefined,'queue_chars');
 const ids=[],index=new Map(),table=[],tableIndex=new Map(),encoded=[];
 const ref=id=>{let at=index.get(id);if(at===undefined){at=ids.length;ids.push(id);index.set(id,at);}return at;};
 const out={...doc};
 for(const name of QUEUE_LISTS){
  if(Array.isArray(doc[name])&&doc[name].every(id=>typeof id==='string')){out[name]=doc[name].map(ref);encoded.push(name);}
 }
 for(const name of QUEUE_MAPS){
  if(!isPlainObject(doc[name]))continue;
  const keys=[],values=[];
  for(const [id,value] of Object.entries(doc[name])){
   const text=JSON.stringify(value);let at=tableIndex.get(text);
   if(at===undefined){at=table.length;table.push(value);tableIndex.set(text,at);}
   keys.push(ref(id));values.push(at);
  }
  out[name]={k:keys,v:values};encoded.push(name);
 }
 out.$queueEncoding=QUEUE_ENCODING;out.$queueEncoded=encoded;out.$queueIds=ids;out.$queueTable=table;
 const body=JSON.stringify(out);
 // The encoding is accepted only when it expands to the identical document.
 if(JSON.stringify(decodeQueueDocument(JSON.parse(body)))!==JSON.stringify(doc))throw failed('prediction_domain_unavailable');
 return QUEUE_PREFIX+body;
}
function decodeQueueDocument(doc){
 if(!isPlainObject(doc)||!Object.hasOwn(doc,'$queueEncoding'))return doc;
 const bad=()=>failed('prediction_domain_unavailable');
 const {$queueEncoding:encoding,$queueEncoded:encoded,$queueIds:ids,$queueTable:table,...rest}=doc;
 if(encoding!==QUEUE_ENCODING||!Array.isArray(encoded)||!Array.isArray(ids)||!Array.isArray(table))throw bad();
 if(new Set(ids).size!==ids.length||!ids.every(id=>typeof id==='string'))throw bad();
 const id=at=>{if(!Number.isInteger(at)||at<0||at>=ids.length)throw bad();return ids[at];};
 for(const name of encoded){
  if(QUEUE_LISTS.includes(name)){
   if(!Array.isArray(rest[name]))throw bad();
   rest[name]=rest[name].map(id);
  }else if(QUEUE_MAPS.includes(name)){
   const packed=rest[name];
   if(!isPlainObject(packed)||!Array.isArray(packed.k)||!Array.isArray(packed.v)||packed.k.length!==packed.v.length)throw bad();
   const map={};
   packed.k.forEach((key,at)=>{const value=packed.v[at];if(!Number.isInteger(value)||value<0||value>=table.length)throw bad();map[id(key)]=table[value];});
   rest[name]=map;
  }else throw bad();
 }
 return rest;
}
// The text that is stored for a queue: plain when it fits, else the encoding; refused when even that exceeds the cap.
function storedQueueText(queue){
 const plain=JSON.stringify(queue);
 if(plain.length<=PREDICTION_QUEUE_CHARS)return plain;
 const text=encodeQueueDocument(plain);
 if(text.length>PREDICTION_QUEUE_CHARS)throw failed('prediction_domain_budget',undefined,'queue_chars');
 return text;
}
function queueStatements(text,generation){
 if(text.length>PREDICTION_QUEUE_CHARS)throw failed('prediction_domain_budget',undefined,'queue_chars');
 const pieces=queuePieces(text);
 return [['DELETE FROM prediction_queue',[]],...pieces.map((chunk,seq)=>['INSERT INTO prediction_queue (seq, chunk_text, generation) VALUES (?,?,?)',[seq,chunk,generation]])];
}
async function loadQueue(db){
 const rows=await many(db,'SELECT chunk_text AS chunk FROM prediction_queue ORDER BY seq');
 if(!rows.length)return null;
 const text=rows.map(row=>row.chunk).join('');
 let doc;try{doc=JSON.parse(text.startsWith(QUEUE_PREFIX)?text.slice(QUEUE_PREFIX.length):text);}catch{throw failed('prediction_domain_unavailable');}
 // New writes always carry the prefix. An encoded document without it was written by the first build that had `dict1` and is read as before.
 // A prefix without the marker is damage.
 if(text.startsWith(QUEUE_PREFIX)&&!(isPlainObject(doc)&&Object.hasOwn(doc,'$queueEncoding')))throw failed('prediction_domain_unavailable');
 return decodeQueueDocument(doc);
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
 const fields=Array.isArray(features.fields)?features.fields:undefined;
 return {...body,generatedAt:row.generatedAt,invalidatedAt:row.invalidatedAt,fingerprintPromptVersion:row.promptVersion,fingerprintSchemaVersion:row.schemaVersion,produced:features.produced||null,previous:features.previous??null,...(fields?{fields}:{})};
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
  ...guardStatements(env),
  ['INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET fingerprint_hash=excluded.fingerprint_hash,schema_version=excluded.schema_version,prompt_version=excluded.prompt_version,generated_at=excluded.generated_at,invalidated_at=excluded.invalidated_at,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,features_json=excluded.features_json',[filmId,hash,features.fingerprintSchemaVersion??0,features.fingerprintPromptVersion,features.generatedAt,features.invalidatedAt,key,digest,JSON.stringify(features)]],
 ]);
 await mirror(env.BUCKET,'enrichment/films/'+encodeURIComponent(filmId)+'/fingerprint.json',value);
}
function pointerColumns(record){
 return [record?.tasteProfileVersion??null,record?.tasteProfileHash??null,record?.fingerprintHash??null,record?.fingerprintSchemaVersion??null,record?.predictionPromptVersion??null,typeof record?.predictedRating==='number'?record.predictedRating:null,record?.r2Key,record?.contentSha256,record?.generatedAt||record?.updatedAt||record?.replacedAt||null];
}
async function savePredictions(env,filmId,bundle,authority){
 const history=Array.isArray(bundle?.history)?bundle.history:[];
 if(history.length>PREDICTION_HISTORY_LIMIT)throw failed('prediction_domain_budget',undefined,'history_limit');
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
  ...guardStatements(env),
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
 const text=storedQueueText(queue);
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
  ...guardStatements(env),
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
 if(authority.tables&&authority.mode==='r2'){const text=JSON.stringify(value);const reserved=await reservePredictionWrite(env,key,authority.generation,text);return {handled:false,claimed:true,token:reserved.token,text};}
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
 return {mode:'r2',tables:authority.tables,version:authority.version,generation:authority.generation,object,queue:object?await object.json():null};
}
function r2Claim(live,head){
 // A head captured before these tables existed must not put once the domain is installed.
 // Mode d1 on either side of a mismatch returns no request. A head that already saw the
 // tables still claims the generation it captured. A head that did not claims the live one.
 if(live.mode==='d1'||head.mode==='d1')return live.mode==='d1'&&head.mode==='d1'?'d1':'refuse';
 if(live.tables||head.tables)return head.tables?head.generation:live.generation;
 return null;
}
export async function writeQueue(env,head,queue){
 const live=await readPredictionAuthority(env?.DB,env);
 const claim=r2Claim(live,head);
 if(claim==='refuse')return null;
 if(claim==='d1'){
  try{await saveQueueDocument(env,queue,head);return {etag:'d1'};}
  catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 const text=JSON.stringify(queue);
 let token=null;
 if(claim!=null){
  try{token=(await reservePredictionWrite(env,QUEUE_KEY,claim,text)).token;}catch(error){if(error.code==='prediction_domain_cas'||error.code==='prediction_domain_not_ready')return null;throw error;}
 }
 let settled=false;
 try{const saved=await env.BUCKET.put(QUEUE_KEY,text,{httpMetadata:{contentType:'application/json'},onlyIf:head.object?{etagMatches:head.object.etag}:{etagDoesNotMatch:'*'}});settled=true;return saved;}
 finally{if(token&&settled)await completePredictionWrite(env,QUEUE_KEY,token);}
}
export async function openLease(env,key){
 const name=key===WRITER_KEY?'writer':'runner';
 const authority=await readPredictionAuthority(env?.DB,env);
 if(authority.mode==='d1'){const lease=await loadLease(env.DB,name);return {mode:'d1',version:authority.version,generation:authority.generation,name,token:lease?.token??null,value:lease?.value??null,object:null};}
 const object=await env.BUCKET.get(key);
 return {mode:'r2',tables:authority.tables,version:authority.version,generation:authority.generation,name,object,value:object?await object.json():null,token:null};
}
export async function writeLease(env,head,value){
 const live=await readPredictionAuthority(env?.DB,env);
 const claim=r2Claim(live,head);
 if(claim==='refuse')return null;
 if(claim==='d1'){
  try{const token=await saveLease(env,head.name,value,head.token,head);return {etag:token};}
  catch(error){if(error.code==='prediction_domain_cas')return null;throw error;}
 }
 const key=head.name==='writer'?WRITER_KEY:RUNNER_KEY;
 const text=JSON.stringify(value);
 let token=null;
 if(claim!=null){
  try{token=(await reservePredictionWrite(env,key,claim,text)).token;}catch(error){if(error.code==='prediction_domain_cas'||error.code==='prediction_domain_not_ready')return null;throw error;}
 }
 let settled=false;
 try{const saved=await env.BUCKET.put(key,text,{httpMetadata:{contentType:'application/json'},onlyIf:head.object?{etagMatches:head.object.etag}:{etagDoesNotMatch:'*'}});settled=true;return saved;}
 finally{if(token&&settled)await completePredictionWrite(env,key,token);}
}
export async function openProfile(env){
 const authority=await readPredictionAuthority(env?.DB,env);
 if(authority.mode==='d1')return {mode:'d1',version:authority.version,generation:authority.generation,profileGeneration:authority.profileGeneration,value:await loadProfile(env),object:null};
 const object=await env.BUCKET.get(PROFILE_KEY);
 return {mode:'r2',version:authority.version,generation:authority.generation,object,value:object?await object.json():null};
}

// Rows of one prediction table that belong to a film in the index, read in keyset pages (film_id is the primary key). A table
// beyond PREDICTION_OVERLAY_ROWS rows is refused and nothing is returned. Rows of films outside the index are read and dropped.
async function overlayRows(db,sql,wanted){
 const rows=[];let after='',total=0;
 for(;;){
  const page=await many(db,sql,[after,PREDICTION_OVERLAY_PAGE]);
  total+=page.length;
  if(total>PREDICTION_OVERLAY_ROWS)throw failed('prediction_domain_budget',undefined,'overlay_rows');
  for(const row of page)if(wanted.has(row.filmId))rows.push(row);
  if(page.length<PREDICTION_OVERLAY_PAGE)return rows;
  after=page[page.length-1].filmId;
 }
}
export async function overlayIndex(env,index,moodFacet){
 const direct=!!env&&typeof env.prepare==='function'&&env.BUCKET==null;
 const db=direct?env:(env?.DB??null);
 const authority=await readPredictionAuthority(db,direct?undefined:env);
 if(authority.mode!=='d1')return index;
 const next={...(index||{})};
 const ids=Object.keys(next),wanted=new Set(ids);
 const byFilm=new Map();
 const [fingerprints,pointers]=await Promise.all([
  overlayRows(db,'SELECT film_id AS filmId, features_json AS features FROM prediction_fingerprint WHERE film_id>? ORDER BY film_id LIMIT ?',wanted),
  overlayRows(db,'SELECT film_id AS filmId, display_json AS display FROM prediction_pointer WHERE film_id>? ORDER BY film_id LIMIT ?',wanted),
 ]);
 for(const row of fingerprints){
  let features;try{features=JSON.parse(row.features);}catch{throw failed('prediction_domain_unavailable');}
  byFilm.set(row.filmId,{...(byFilm.get(row.filmId)||{}),features});
 }
 for(const row of pointers){
  let display;try{display=JSON.parse(row.display);}catch{throw failed('prediction_domain_unavailable');}
  byFilm.set(row.filmId,{...(byFilm.get(row.filmId)||{}),display});
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
 if(history.length>PREDICTION_HISTORY_LIMIT)throw failed('prediction_domain_budget',undefined,'history_limit');
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
async function assertFingerprintBodies(bucket,snapshot){
 const items=snapshot?.fingerprints;
 if(!Array.isArray(items))return;
 for(const item of items){
  const hash=item?.record?.fingerprintHash;
  if(typeof hash!=='string'||!hash)throw failed('prediction_domain_body_missing');
  const stored=await readBody(bucket,fingerprintKey(item.filmId,hash));
  if(stored.fingerprintHash!==hash)throw failed('prediction_domain_body_mismatch');
 }
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
 // A missing immutable fingerprint body must not hold writers or copy a prefix of the rows.
 await assertFingerprintBodies(bucket,snapshot);
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
   else if(unit.kind==='queue')body=queueStatements(storedQueueText(unit.value),fence.queueGeneration);
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
export async function reconcilePredictionIntents(db,bucket){
 const authority=await readPredictionAuthority(db);
 if(!authority.tables||authority.mode!=='r2')throw failed('prediction_domain_not_ready');
 const rows=await many(db,'SELECT key, token, body_sha256 AS bodySha256 FROM prediction_domain_intent ORDER BY key');
 let committed=0;
 const pending=[];
 try{
  for(const row of rows){
   const text=await objectText(bucket,row.key);
   const digest=text==null?null:await sha256(text);
   if(digest!==row.bodySha256){pending.push(row.key);continue;}
   await fenced(db,[
    ['DELETE FROM prediction_domain_intent WHERE key=? AND token=?',[row.key,row.token]],
    [FENCE_SQL,[]],
   ]);
   committed++;
  }
  if(pending.length){
   const error=failed('prediction_domain_busy');
   error.committedUnits=committed;
   throw error;
  }
  return {cleared:committed,mode:authority.mode,writes:authority.writes};
 }catch(error){
  if(error&&error.committedUnits==null)error.committedUnits=committed;
  throw error;
 }
}
const MIRROR_LIST_LIMIT=5000;
async function listedKeys(bucket,prefix){
 if(typeof bucket.list!=='function')throw failed('prediction_domain_parity');
 const keys=[];
 let cursor;
 do{
  const page=await bucket.list({prefix,limit:100,...(cursor?{cursor}:{})});
  for(const object of page?.objects||[])keys.push(object.key);
  if(keys.length>MIRROR_LIST_LIMIT)throw failed('prediction_domain_budget',undefined,'mirror_list');
  if(page?.truncated&&!(page.cursor||page.nextCursor))throw failed('prediction_domain_parity');
  cursor=page?.truncated?page.cursor||page.nextCursor:null;
 }while(cursor);
 return keys;
}
async function deleteSent(bucket,key){
 if(typeof bucket.delete!=='function')throw failed('prediction_domain_parity');
 try{await bucket.delete(key);}catch(error){const wrapped=failed('prediction_domain_parity',error);wrapped.kind='write_uncertain';throw wrapped;}
}
async function putSent(bucket,key,value){
 const text=JSON.stringify(value);
 try{await bucket.put(key,text,{httpMetadata:{contentType:'application/json'}});}catch(error){const wrapped=failed('prediction_domain_parity',error);wrapped.kind='write_uncertain';throw wrapped;}
 return text;
}
async function readBack(bucket,key,text){
 const back=await objectText(bucket,key);
 if(back!==text)throw failed('prediction_domain_parity');
}
async function repairMirrors(db,bucket){
 let committed=0;
 try{
  const env={DB:db,BUCKET:bucket};
  const keep=new Set();
  const put=async(key,value)=>{const text=await putSent(bucket,key,value);committed++;await readBack(bucket,key,text);keep.add(key);};
  for(const row of await many(db,'SELECT film_id AS filmId FROM prediction_fingerprint ORDER BY film_id')){
   const value=await loadFingerprint(env,row.filmId);
   if(!value)throw failed('prediction_domain_parity');
   await put('enrichment/films/'+encodeURIComponent(row.filmId)+'/fingerprint.json',value);
  }
  const predictionIds=new Set();
  for(const row of await many(db,'SELECT film_id AS filmId FROM prediction_pointer ORDER BY film_id'))predictionIds.add(row.filmId);
  for(const row of await many(db,'SELECT DISTINCT film_id AS filmId FROM prediction_lineage ORDER BY film_id'))predictionIds.add(row.filmId);
  for(const filmId of [...predictionIds].sort()){
   const value=await loadPredictions(env,filmId);
   if(!value)throw failed('prediction_domain_parity');
   await put('enrichment/films/'+encodeURIComponent(filmId)+'/predictions.json',value);
  }
  const queue=await loadQueue(db);
  if(queue)await put(QUEUE_KEY,queue);
  const profile=await loadProfile(env);
  if(profile)await put(PROFILE_KEY,profile);
  for(const row of await many(db,'SELECT run_id AS runId FROM prediction_run ORDER BY run_id')){
   const value=await loadRun(db,row.runId);
   if(!value)throw failed('prediction_domain_parity');
   await put('enrichment/runs/'+row.runId+'.json',value);
  }
  const latest=await loadLatest(db);
  if(latest)await put(LATEST_KEY,latest);
  for(const [name,key] of [['runner',RUNNER_KEY],['writer',WRITER_KEY]]){
   const lease=await loadLease(db,name);
   await put(key,lease?.value??{expiresAt:0});
  }
  for(const key of await listedKeys(bucket,'enrichment/')){
   if(!predictionMutableKey(key)||keep.has(key))continue;
   await deleteSent(bucket,key);
   committed++;
   if(await bucket.get(key))throw failed('prediction_domain_parity');
  }
  return committed;
 }catch(error){
  if(error&&error.committedUnits==null)error.committedUnits=committed;
  throw error;
 }
}
export async function revertPredictionDomain(db,bucket,expected){
 const authority=await readPredictionAuthority(db);
 if(authority.mode!=='d1'||authority.generation!==expected?.generation||authority.queueGeneration!==expected?.queueGeneration||authority.profileGeneration!==expected?.profileGeneration)throw failed('prediction_domain_cas');
 let committed=0;
 try{
  committed=await repairMirrors(db,bucket);
  const repaired=await readPredictionAuthority(db);
  if(repaired.mode!=='d1'||repaired.generation!==authority.generation||repaired.queueGeneration!==authority.queueGeneration||repaired.profileGeneration!==authority.profileGeneration)throw failed('prediction_domain_cas');
  await fenced(db,[
   ["UPDATE prediction_domain_authority SET mode='r2', writes='open' WHERE id=1 AND mode='d1' AND generation=? AND queue_generation=? AND profile_generation=? AND NOT EXISTS (SELECT 1 FROM prediction_domain_intent)",[authority.generation,authority.queueGeneration,authority.profileGeneration]],
   [FENCE_SQL,[]],
  ]);
  const now=await readPredictionAuthority(db);
  if(now.mode!=='r2')throw failed('prediction_domain_cas');
  return now;
 }catch(error){
  if(error&&error.committedUnits==null)error.committedUnits=committed;
  throw error;
 }
}
