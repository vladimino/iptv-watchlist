#!/usr/bin/env node
// Production entry for the prediction domain (ADR 0078, ADR 0162). Default is read-only status.
// --apply sends only migrations/0007_prediction_authority.sql, and only after --producers-drained and an idle runner and writer lease.
// A deploy is not that drain. A fresh apply leaves the marker in mode r2, which the Worker refuses: the load, activate, release, reconcile and
// revert commands of the former R2 to D1 cutover are retired (ADR 0162) and answer `retired` before any request.
// --materialize-fingerprints writes a missing immutable fingerprint body create-only when the pointer reconstructs to that hash. An existing
// body that disagrees refuses before any put. It does not open D1. A PUT whose response is lost is writeState unknown and is not retried.
// A HEAD that fails before the PUT is not an uncertain write. It is a repair of an immutable R2 body, not a return to R2.
// An unrecognized failure keeps reason failed and adds detail: the error name, a short code or kind, and a message with hashes, film ids and
// credentials removed. It writes only in the production bucket iptv on the account endpoint. Each write needs its own --confirm and --target iptv.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createD1Adapter, DEFAULT_ENDPOINT, renderSql} from './d1-backfill.mjs';
import {createS3Store, readInstallCredentials} from './r2-s3-store.mjs';
import {migrationStatements, OperatorStop, PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID, PRODUCTION_DATABASE_NAME, STATEMENT_BYTES} from './metadata-cache-production.mjs';
import {PREDICTION_INDEX_LIMIT, fingerprintKey, fingerprintPointerAgrees, predictionMutableKey, sameCanonical} from '../src/prediction-d1.js';
import {createReadOnlyClient, readCredentials} from './r2-snapshot-export.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const MIGRATION_PATH=path.join(ROOT,'migrations/0007_prediction_authority.sql');
const TABLES=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent'];
const PREDICTION_BATCH_STATEMENTS=120;
const PREDICTION_BATCH_BYTES=4*1024*1024;
const QUEUE_KEY='enrichment/prediction-queue.json';
const PROFILE_KEY='enrichment/profile/current.json';
const RUNNER_KEY='enrichment/runner-lease.json';
const WRITER_KEY='enrichment/writer-lease.json';
const LATEST_KEY='enrichment/latest-run.json';

export function parsePredictionArgs(argv){
 const args=argv.slice(2);
 const value=name=>{
  const index=args.indexOf(name);
  if(index<0)return undefined;
  const next=args[index+1];
  if(next===undefined||next.startsWith('--'))throw new OperatorStop('usage',2);
  return next;
 };
 if(['--load','--activate','--revert','--release','--reconcile'].some(name=>args.includes(name)))throw new OperatorStop('retired',2);
 const commands=['--apply','--materialize-fingerprints'].filter(name=>args.includes(name));
 if(commands.length>1)throw new OperatorStop('usage',2);
 const known=new Set([...commands,'--target','--confirm','--producers-drained']);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(arg==='--target'||arg==='--confirm'){value(arg);index++;continue;}
  if(arg==='--producers-drained')continue;
  if(!known.has(arg))throw new OperatorStop('usage',2);
 }
 const command=commands[0]?commands[0].slice(2):'status';
 const producersDrained=args.includes('--producers-drained');
 const target=args.includes('--target')?value('--target'):undefined;
 const confirm=args.includes('--confirm')?value('--confirm'):undefined;
 if(producersDrained&&command!=='apply')throw new OperatorStop('usage',2);
 if(command==='apply'&&!producersDrained)throw new OperatorStop('producers_not_drained',2);
 if(target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='apply'&&confirm!=='apply')throw new OperatorStop('confirm',2);
 if(command==='materialize-fingerprints'&&confirm!=='materialize')throw new OperatorStop('confirm',2);
 if(command==='status'&&confirm!==undefined)throw new OperatorStop('usage',2);
 return {command,confirm,producersDrained};
}

function filmIdFrom(key){
 const match=String(key).match(/^enrichment\/films\/([^/]+)\/(?:fingerprint|predictions)\.json$/);
 if(!match)return null;
 try{return decodeURIComponent(match[1]);}catch{return null;}
}
async function objectJson(store,key){
 const got=await store.get(key);
 if(!got)return null;
 if(typeof got.json==='function')return got.json();
 if(got.body)return JSON.parse(await new Response(got.body).text());
 return null;
}
function rememberMutable(keys,key,counts){
 const kind=predictionMutableKey(key);
 if(!kind)return;
 if(kind==='fingerprint'&&++counts.fingerprints>PREDICTION_INDEX_LIMIT)throw new OperatorStop('prediction_domain_budget',3);
 if(kind==='predictions'&&++counts.predictions>PREDICTION_INDEX_LIMIT)throw new OperatorStop('prediction_domain_budget',3);
 keys.push(key);
}
async function listKeys(store,prefix){
 const keys=[];
 const counts={fingerprints:0,predictions:0};
 if(typeof store.keys==='function'){
  for(const key of await store.keys(prefix))rememberMutable(keys,key,counts);
  return keys;
 }
 let cursor;
 do{
  const page=typeof store.list==='function'&&store.list.length!==1?await store.list({prefix,cursor}):await store.list(cursor);
  for(const item of page.objects||[]){
   const key=String(item.key);
   if(prefix&&!key.startsWith(prefix))continue;
   rememberMutable(keys,key,counts);
  }
  cursor=page.truncated?page.cursor||page.nextCursor:null;
 }while(cursor);
 return keys;
}
export async function readPredictionSnapshot(store){
 const [queue,profile,latest,runner,writer,keys]=await Promise.all([
  objectJson(store,QUEUE_KEY),objectJson(store,PROFILE_KEY),objectJson(store,LATEST_KEY),objectJson(store,RUNNER_KEY),objectJson(store,WRITER_KEY),listKeys(store,'enrichment/'),
 ]);
 const fingerprints=[],predictions=[],runs=[];
 for(const key of keys){
  if(/\/fingerprint\.json$/.test(key)){const record=await objectJson(store,key);if(record)fingerprints.push({filmId:filmIdFrom(key),record});}
  else if(/\/predictions\.json$/.test(key)){const bundle=await objectJson(store,key);if(bundle)predictions.push({filmId:filmIdFrom(key),bundle});}
  else if(/^enrichment\/runs\/[^/]+\.json$/.test(key)){const run=await objectJson(store,key);if(run?.runId)runs.push(run);}
 }
 return {queue,profile,fingerprints,predictions,runs,latestRunId:latest?.runId??null,leases:{runner,writer}};
}
function leasesBusy(snapshot,now){
 return [snapshot.leases?.runner,snapshot.leases?.writer].some(lease=>lease&&Number(lease.expiresAt)>now);
}
const FAILURE_TOKEN=/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
export function publicFailureDetail(error){
 if(!error||typeof error!=='object')return null;
 const detail={name:FAILURE_TOKEN.test(error.name)?error.name:'Error'};
 for(const key of ['code','kind','phase']){
  if(typeof error[key]==='string'&&FAILURE_TOKEN.test(error[key]))detail[key]=error[key];
 }
 if(Number.isInteger(error.status)&&error.status>=100&&error.status<=599)detail.status=error.status;
 const message=redactFailureText(error.message);
 if(message)detail.message=message;
 return detail;
}
function redactFailureText(value){
 let text=String(value??'').replace(/\s+/g,' ').trim();
 if(!text)return '';
 text=text.replace(/https?:\/\/[^\s]+/g,match=>{
  try{
   const url=new URL(match);
   return url.origin+url.pathname.replace(/\/films\/[^/]+/g,'/films/[id]').replace(/\/runs\/[^/]+/g,'/runs/[id]');
  }catch{return '[url]';}
 });
 text=text.replace(/\b[0-9a-f]{32,}\b/gi,'[redacted]');
 text=text.replace(/enrichment\/films\/[^/\s]+/g,'enrichment/films/[id]');
 text=text.replace(/enrichment\/runs\/[^/\s]+/g,'enrichment/runs/[id]');
 text=text.replace(/(bearer|token|secret|password|signature|access[_-]?key)\s*[:=]\s*\S+/gi,'$1=[redacted]');
 return text.length>180?text.slice(0,180):text;
}
function domainError(error){
 if(error instanceof OperatorStop)return error;
 if(error?.kind==='write_uncertain')return Object.assign(new OperatorStop('write_uncertain',3),{kind:'write_uncertain',committedUnits:error.committedUnits});
 if(error?.kind==='batch_too_large')return Object.assign(new OperatorStop('batch_too_large',3),{committedUnits:error.committedUnits});
 const code=error?.code;
 let stop;
 if(code==='prediction_domain_busy')stop=new OperatorStop('prediction_domain_busy',3);
 else if(code==='prediction_domain_cas')stop=new OperatorStop('prediction_domain_fence',3);
 else if(code==='prediction_domain_parity')stop=new OperatorStop('prediction_domain_parity',3);
 else if(code==='prediction_domain_body_missing'||code==='prediction_domain_body_mismatch'||code==='prediction_domain_unlinked')stop=new OperatorStop(code,3);
 else if(code==='prediction_domain_budget')stop=new OperatorStop('prediction_domain_budget',3);
 else if(code==='prediction_domain_unavailable'||code==='prediction_domain_not_ready')stop=new OperatorStop(code,3);
 else {stop=new OperatorStop('failed',1);stop.detail=publicFailureDetail(error);}
 if(error?.committedUnits!=null)stop.committedUnits=error.committedUnits;
 return stop;
}
export function createPredictionBinding(adapter){
 return {
  prepare(sql){
   return {bind(...params){
    if(params.length>100)throw new OperatorStop('batch_too_large',3);
    const text=renderSql(sql,params);
    if(Buffer.byteLength(text,'utf8')>STATEMENT_BYTES)throw new OperatorStop('batch_too_large',3);
    return {
     text,
     async first(){return (await adapter.get(sql,params))??null;},
     async all(){return {results:await adapter.all(sql,params)};},
     async run(){await adapter.run(sql,params);return {success:true};},
    };
   }};
  },
  async batch(statements){
   let bytes=0;
   const texts=[];
   for(const item of statements){
    const text=String(item?.text||'');
    const size=Buffer.byteLength(text,'utf8');
    if(size>STATEMENT_BYTES)throw new OperatorStop('batch_too_large',3);
    bytes+=size;
    texts.push(text);
   }
   if(!texts.length)return;
   if(texts.length>PREDICTION_BATCH_STATEMENTS||bytes>PREDICTION_BATCH_BYTES)throw new OperatorStop('batch_too_large',3);
   await adapter.executeSql(texts);
  },
 };
}

// A raw, never-refusing read of the marker for status and the schema apply: the Worker's reader refuses an uninstalled domain and a marker in mode r2,
// and an operator must still be able to see both.
async function readState(binding){
 const first=async sql=>(await binding.prepare(sql).bind().first())??null;
 let version=null;
 try{version=(await first('SELECT version FROM schema_contract WHERE id=1'))?.version??null;}catch{version=null;}
 const tables=await tablesOf(binding);
 const installed=present(tables);
 let row=null;
 if(installed)row=await first('SELECT mode, generation, queue_generation AS queueGeneration, profile_generation AS profileGeneration, writes FROM prediction_domain_authority WHERE id=1');
 return {version:version==null?null:Number(version),binding:true,tables:installed,mode:row?.mode??null,writes:row?.writes??null,generation:row?Number(row.generation):0,queueGeneration:row?Number(row.queueGeneration):0,profileGeneration:row?Number(row.profileGeneration):0};
}
async function tablesOf(binding){
 const names=(await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(name=>"'"+name+"'").join(',')+")").bind().all()).results.map(row=>row.name);
 return Object.fromEntries(TABLES.map(name=>[name,names.includes(name)]));
}
function present(tables){return TABLES.every(name=>tables[name]);}

async function applyMigration(binding){
 const authority=await readState(binding);
 if(authority.tables)throw new OperatorStop('already_applied',3);
 if(!(Number(authority.version)>=6))throw new OperatorStop('schema_unexpected',3);
 const statements=migrationStatements(fs.readFileSync(MIGRATION_PATH,'utf8'));
 if(!statements.length||statements.some(sql=>/\bINSERT\s+INTO\s+film\b/i.test(sql)))throw new OperatorStop('migration_refused',3);
 await binding.batch(statements.map(sql=>binding.prepare(sql).bind()));
 const readback=await readState(binding);
 if(!readback.tables||Number(readback.version)<7||readback.mode!=='r2'||readback.writes!=='open'||readback.generation!==0||readback.queueGeneration!==0||readback.profileGeneration!==0)throw new OperatorStop('readback_mismatch',3);
 return {operation:'apply',writes:true,writeState:'committed',schemaVersion:readback.version,mode:readback.mode,generation:readback.generation};
}

async function materializeFingerprintBodies(store){
 const snapshot=await readPredictionSnapshot(store);
 const planned=[];
 for(const item of snapshot.fingerprints){
  const body=await fingerprintPointerAgrees(item.record);
  if(!body)throw new OperatorStop('prediction_domain_body_mismatch',3);
  const key=fingerprintKey(item.filmId,item.record.fingerprintHash);
  const existing=await objectJson(store,key);
  if(existing==null)planned.push({key,text:JSON.stringify(body)});
  else if(!await sameCanonical(existing,body))throw new OperatorStop('prediction_domain_body_mismatch',3);
 }
 let created=0;
 try{
  for(const item of planned){
   const put=typeof store.putIfAbsent==='function'?store.putIfAbsent(item.key,item.text):store.put(item.key,item.text,{onlyIf:{etagDoesNotMatch:'*'}});
   let result;
   try{result=await put;}
   catch(error){
    if(error?.phase==='before-put')throw error;
    if(error&&typeof error==='object'){error.kind='write_uncertain';error.phase=error.phase||'put';error.committedUnits=created;}
    throw error;
   }
   if(result==null){
    const again=await objectJson(store,item.key);
    if(!again||!await sameCanonical(again,JSON.parse(item.text))){
     const error=new OperatorStop('prediction_domain_body_mismatch',3);
     error.committedUnits=created;
     throw error;
    }
    continue;
   }
   created++;
  }
 }catch(error){
  if(error?.kind==='write_uncertain')throw error;
  if(error&&error.committedUnits==null)error.committedUnits=created;
  throw error;
 }
 return {operation:'materialize-fingerprints',writes:created>0,writeState:created>0?'committed':'none',created,unchanged:snapshot.fingerprints.length-planned.length,planned:planned.length};
}
function productionTarget(env){
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim();
 const apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 const configuredId=String(env.D1_BACKFILL_DATABASE_ID||'').trim();
 if(!/^[0-9a-f]{32}$/.test(accountId)||!apiToken)throw new OperatorStop('configuration',2);
 if(accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(configuredId&&configuredId!==PRODUCTION_DATABASE_ID)throw new OperatorStop('database_id_mismatch',3);
 const endpoint=String(env.D1_BACKFILL_ENDPOINT||'').trim();
 if(endpoint&&endpoint!==DEFAULT_ENDPOINT)throw new OperatorStop('endpoint_refused',3);
 return {accountId,apiToken,endpoint:endpoint||DEFAULT_ENDPOINT,maxBatchStatements:PREDICTION_BATCH_STATEMENTS,maxBatchBytes:PREDICTION_BATCH_BYTES};
}
function writeOutcome(error,stop){
 const units=Number(error?.committedUnits??stop?.committedUnits??0);
 if(stop?.reason==='write_uncertain'||error?.kind==='write_uncertain')return {writes:true,writeState:'unknown',...(units>0?{committedUnits:units}:{})};
 if(units>0)return {writes:true,writeState:'partial',committedUnits:units};
 return {writes:false,writeState:'none'};
}
async function assertProducersDrained(store,now){
 let runner,writer;
 try{
  runner=await objectJson(store,RUNNER_KEY);
  writer=await objectJson(store,WRITER_KEY);
 }catch{throw new OperatorStop('quiescence_unproven',3);}
 if(leasesBusy({leases:{runner,writer}},now))throw new OperatorStop('prediction_domain_busy',3);
}
const PRODUCTION_R2_ENDPOINT='https://'+PRODUCTION_ACCOUNT_ID+'.r2.cloudflarestorage.com';

function readStore(env,fetchImpl){
 let credentials;
 try{credentials=readCredentials(env);}catch{throw new OperatorStop('source_missing',3);}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID||credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 const client=createReadOnlyClient({credentials,fetchImpl});
 return {async get(key){return client.get(key);},async list(cursor){return client.list(cursor);},async put(){throw new OperatorStop('r2_write_refused',3);}};
}
function writeStore(env,fetchImpl,keys){
 let credentials;
 try{credentials=readInstallCredentials(env);}catch{throw new OperatorStop('writer_missing',3);}
 const accountId=credentials.accountId||env.R2_SNAPSHOT_ACCOUNT_ID;
 if(accountId!==PRODUCTION_ACCOUNT_ID||credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 if(credentials.endpoint!==PRODUCTION_R2_ENDPOINT||credentials.endpointOverride)throw new OperatorStop('endpoint_refused',3);
 const allowed=keys||new Set();
 const allowedDeletes=new Set();
 const store=createS3Store({credentials,fetchImpl,allowedWrites:allowed,allowedDeletes});
 return {async get(key){return store.get(key);},async put(key,body){allowed.add(key);const head=await store.head(key);return store.put(key,body,{onlyIf:head?{etagMatches:head.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});},async putIfAbsent(key,body){allowed.add(key);let head;try{head=await store.head(key);}catch(error){if(error&&typeof error==='object')error.phase='before-put';throw error;}if(head)return null;try{return await store.put(key,body,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});}catch(error){if(error&&typeof error==='object'){error.kind='write_uncertain';error.phase='put';}throw error;}},async delete(key){if(!predictionMutableKey(key))throw new OperatorStop('r2_write_refused',3);allowedDeletes.add(key);await store.delete(key);},async list(){const page=await store.list({prefix:'enrichment/'});return {objects:page.objects,truncated:false};},async keys(prefix){const page=await store.list({prefix});return page.objects.map(item=>item.key).filter(key=>!prefix||key.startsWith(prefix));}};
}

export async function runPredictionDomainProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),binding=null,store=null}={}){
 try{
  const parsed=parsePredictionArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  const clock=typeof now==='function'?now():now;
  if(parsed.command==='materialize-fingerprints'){
   const bucket=store||writeStore(env,fetchImpl);
   return {exit:0,result:await materializeFingerprintBodies(bucket)};
  }
  let db=binding,bucket=store;
  if(!db){
   const target=productionTarget(env);
   const adapter=createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   db=createPredictionBinding(adapter);
  }
  if(parsed.command==='status'){
   const authority=await readState(db);
   const tables=await tablesOf(db);
   return {exit:0,result:{configured:true,writes:false,writeState:'none',schemaVersion:authority.version,mode:authority.mode,binding:authority.binding,tables:present(tables),generation:authority.generation,queueGeneration:authority.queueGeneration,profileGeneration:authority.profileGeneration}};
  }
  if(parsed.command==='apply'){
   if(!bucket)bucket=readStore(env,fetchImpl);
   await assertProducersDrained(bucket,clock);
   return {exit:0,result:await applyMigration(db)};
  }
  throw new OperatorStop('usage',2);
 }catch(error){
  const stop=domainError(error);
  return {exit:stop.exit,result:{reason:stop.reason,...(stop.detail?{detail:stop.detail}:{}),...writeOutcome(error,stop)}};
 }
}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 runPredictionDomainProduction().then(({exit,result})=>{
  process.stdout.write(JSON.stringify(result)+'\n');
  const suffix=result.detail?.message?': '+result.detail.message:'';
  if(exit===2)process.stderr.write('refuse: '+result.reason+suffix+'\n');
  else if(exit===3)process.stderr.write('no-go: '+result.reason+suffix+'\n');
  else if(exit!==0)process.stderr.write('error: '+result.reason+suffix+'\n');
  process.exit(exit);
 }).catch(error=>{
  const detail=publicFailureDetail(error);
  process.stdout.write(JSON.stringify({reason:'failed',writes:false,writeState:'none',...(detail?{detail}:{})})+'\n');
  process.stderr.write('error: failed'+(detail?.message?': '+detail.message:'')+'\n');
  process.exit(1);
 });
}
