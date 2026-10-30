// Local D1 backfill executor. It imports a verified production baseline (the read-only exporter's manifest) into the target
// D1 database through the Cloudflare D1 HTTP API, or into a local SQLite file for a dry-run, with the importer's identity,
// evidence and parity rules. It writes only to the target it was given, never to R2, never through a Worker binding, and it
// refuses to write until the target's identity, schema and batch atomicity have been checked in this very run.
// Executing it against the production database is a separately approved operation; this module grants none.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {PUBLISH_BUDGET_MS,DEFAULT_CHUNK_BYTES,DEFAULT_CHUNK_STATEMENTS,STAGE_TABLES,StageStop,discardStage,publishStaged} from '../src/generation-stage.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {importBatch,refusal} from '../src/offline-importer.js';
import {ExportError} from './migration-export.mjs';
import {openSqlite,prepareImport} from './offline-import.mjs';
import {STATUS_CONSISTENT,verifyProductionSnapshot} from './r2-snapshot-export.mjs';
import {SnapshotError} from './snapshot-store.mjs';

export const TARGET_DATABASE_NAME='iptv';
export const DEFAULT_ENDPOINT='https://api.cloudflare.com/client/v4';
// Conservative defaults. The probe proves the configured size on the scratch database before any target write; a unit above it stops the run.
export const DEFAULT_MAX_BATCH_STATEMENTS=1000;
export const DEFAULT_MAX_BATCH_BYTES=1024*1024;
export const IDENTITY_SOURCE_KEY='manifest.json';
export const IDENTITY_TARGET_TABLE='database';
const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const TRANSIENT=new Set([429,500,502,503,504]);
const sleepFor=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

export class BackfillStop extends Error{constructor(reason,details={}){super('Backfill stopped: '+reason);this.name='BackfillStop';this.reason=reason;this.details=details;}}
// Every failure except a rejected statement is fatal to the run: it says nothing about the data and must not be booked as a conflict.
export class D1Error extends Error{constructor(kind,message,details={}){super(message);this.name='D1Error';this.kind=kind;this.details=details;this.fatal=kind!=='statement';}}

// The target comes from the local environment only. The scratch database is required for the atomicity probe that precedes every write.
export function readTarget(env=process.env){
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim(),apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 const databaseId=String(env.D1_BACKFILL_DATABASE_ID||'').trim(),scratchDatabaseId=String(env.D1_BACKFILL_SCRATCH_DATABASE_ID||'').trim();
 const databaseName=String(env.D1_BACKFILL_DATABASE_NAME||TARGET_DATABASE_NAME).trim();
 if(!/^[0-9a-f]{32}$/.test(accountId))throw new ExportError('configuration','D1_BACKFILL_ACCOUNT_ID must be the 32-character account id');
 if(!apiToken)throw new ExportError('configuration','D1_BACKFILL_API_TOKEN is required in the environment');
 if(!/^[0-9a-f-]{36}$/.test(databaseId))throw new ExportError('configuration','D1_BACKFILL_DATABASE_ID must be the database uuid');
 if(!/^[0-9a-f-]{36}$/.test(scratchDatabaseId))throw new ExportError('configuration','D1_BACKFILL_SCRATCH_DATABASE_ID must be the scratch database uuid');
 if(scratchDatabaseId===databaseId)throw new ExportError('configuration','The scratch database must differ from the target database');
 if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(databaseName))throw new ExportError('configuration','D1_BACKFILL_DATABASE_NAME is not a database name');
 const endpoint=endpointFor(env.D1_BACKFILL_ENDPOINT);
 const maxBatchStatements=bounded(env.D1_BACKFILL_MAX_BATCH_STATEMENTS,DEFAULT_MAX_BATCH_STATEMENTS),maxBatchBytes=bounded(env.D1_BACKFILL_MAX_BATCH_BYTES,DEFAULT_MAX_BATCH_BYTES);
 return {accountId,apiToken,databaseId,scratchDatabaseId,databaseName,endpoint,endpointOverride:!!String(env.D1_BACKFILL_ENDPOINT||'').trim(),maxBatchStatements,maxBatchBytes};
}
function bounded(value,fallback){if(value==null||value==='')return fallback;const number=Number(value);if(!Number.isInteger(number)||number<1)throw new ExportError('configuration','Batch limits must be positive integers');return number;}
export function endpointFor(override){
 const value=String(override||'').trim();
 if(!value)return DEFAULT_ENDPOINT;
 let url;try{url=new URL(value);}catch{throw new ExportError('configuration','D1_BACKFILL_ENDPOINT is not a URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw new ExportError('configuration','D1_BACKFILL_ENDPOINT must be https, or http on loopback for a local test server');
 return url.origin+url.pathname.replace(/\/$/,'');
}

// Parameters are rendered as literals, as the SQLite adapter does, because one HTTP batch carries many statements with different values.
export function renderSql(sql,params=[]){let index=0;const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});if(index!==params.length)throw new Error('Unused SQL parameter');return text;}
function literal(value){if(value==null)return 'NULL';if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}if(typeof value==='boolean')return value?'1':'0';return "'"+String(value).replaceAll("'","''")+"'";}

// The D1 HTTP adapter. Reads are single statements. Writes are buffered inside transaction() and sent as ONE request whose
// statements are executed together; whether that execution is atomic is not assumed but proven by probeAtomicity on the
// scratch database before the first production write. A write request whose outcome is unknown (the connection failed
// after sending) is never retried: the run stops and the next run reconciles through the importer's read-back.
export function createD1Adapter({target,databaseId,fetchImpl=fetch,retries=4,sleep=sleepFor,timeoutMs=120000}){
 const stats={requests:0,reads:0,batches:0,statements:0,largestBatchStatements:0,largestBatchBytes:0,retries:0};
 const state={buffer:null};
 const base=target.endpoint+'/accounts/'+target.accountId+'/d1/database/'+databaseId;
 const headers={Authorization:'Bearer '+target.apiToken,'Content-Type':'application/json'};
 async function request(method,url,body,{write=false}={}){
  for(let attempt=0;;attempt++){
   stats.requests++;
   let response;
   try{response=await fetchImpl(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
   catch(error){
    if(write)throw new D1Error('write_uncertain','A write request failed in transit; its outcome is unknown and it is not retried');
    if(attempt<retries){stats.retries++;await sleep(100*2**attempt);continue;}
    throw new D1Error('network','D1 request failed after retries');
   }
   let payload=null;try{payload=await response.json();}catch{payload=null;}
   // A transient status on a write says nothing about whether the batch committed: never repeat it, stop and reconcile on the next run.
   if(write&&TRANSIENT.has(response.status))throw new D1Error('write_uncertain','A write request answered HTTP '+response.status+'; its outcome is unknown and it is not retried',{status:response.status});
   if(TRANSIENT.has(response.status)&&attempt<retries){stats.retries++;await sleep(100*2**attempt);continue;}
   if(response.status===401||response.status===403)throw new D1Error('authorization','D1 credential was refused');
   if(!response.ok||payload?.success===false){const message=payload?.errors?.[0]?.message||('D1 request failed with HTTP '+response.status);throw new D1Error(write?'statement':'request',message,{status:response.status});}
   return payload;
  }
 }
 async function query(sql,{write=false}={}){
  const payload=await request('POST',base+'/query',{sql},{write});
  const results=Array.isArray(payload?.result)?payload.result:[];
  if(results.some(item=>item&&item.success===false))throw new D1Error('statement',results.find(item=>item.success===false)?.error||'A statement failed');
  return results;
 }
 return {
  stats,
  async describe(){const payload=await request('GET',base,undefined);const result=payload?.result||{};return {uuid:result.uuid??null,name:result.name??null};},
  run(sql,params=[]){
   const statement=renderSql(sql,params)+';';
   if(state.buffer){state.buffer.push(statement);return Promise.resolve();}
   stats.batches++;stats.statements++;
   return query(statement,{write:true}).then(()=>undefined);
  },
  async get(sql,params=[]){const rows=await this.all(sql,params);return rows[0]??null;},
  async all(sql,params=[]){
   if(state.buffer)throw new Error('Read inside the import transaction');
   stats.reads++;
   const results=await query(renderSql(sql,params)+';');
   return results[0]?.results||[];
  },
  async transaction(fn){
   if(state.buffer)return fn();
   state.buffer=[];
   try{
    await fn();
    const statements=state.buffer;
    if(!statements.length)return;
    const text=statements.join('\n'),bytes=Buffer.byteLength(text,'utf8');
    if(statements.length>target.maxBatchStatements||bytes>target.maxBatchBytes)throw new D1Error('batch_too_large','A unit needs '+statements.length+' statements and '+bytes+' bytes, above the configured batch limits; the unit is not split because atomicity across requests is not available');
    stats.batches++;stats.statements+=statements.length;stats.largestBatchStatements=Math.max(stats.largestBatchStatements,statements.length);stats.largestBatchBytes=Math.max(stats.largestBatchBytes,bytes);
    await query(text,{write:true});
   }finally{state.buffer=null;}
  },
 };
}

// Proof, not assumption, at the configured size: a full-size batch must apply every statement, and the same batch whose last
// statement fails must leave no row of its earlier statements. Both run on the scratch database only.
export async function probeAtomicity(adapter,{statements=DEFAULT_MAX_BATCH_STATEMENTS,bytes=DEFAULT_MAX_BATCH_BYTES}={}){
 const table='backfill_atomicity_probe';
 const rows=Math.max(2,statements-1),pad='x'.repeat(Math.max(1,Math.floor(bytes*0.9/rows)-60));
 const fill=async()=>{for(let id=1;id<=rows;id++)await adapter.run('INSERT INTO '+table+' (id,note) VALUES (?,?)',[id,pad]);};
 await adapter.run('DROP TABLE IF EXISTS '+table);
 await adapter.run('CREATE TABLE '+table+' (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
 await adapter.transaction(fill);
 const applied=(await adapter.get('SELECT COUNT(*) AS n FROM '+table)).n;
 await adapter.run('DELETE FROM '+table);
 let failed=false;
 try{await adapter.transaction(async()=>{await fill();await adapter.run('INSERT INTO '+table+'_missing (id) VALUES (?)',[0]);});}
 catch(error){failed=error instanceof D1Error&&error.kind==='statement';if(!failed)throw error;}
 const remaining=(await adapter.get('SELECT COUNT(*) AS n FROM '+table)).n;
 await adapter.run('DROP TABLE IF EXISTS '+table);
 return {statements:rows+1,approxBytes:rows*(pad.length+60),multiStatement:applied===rows,lastStatementFailed:failed,rowsAfterFailure:remaining,atomic:applied===rows&&failed&&remaining===0};
}

// Every run needs the whole schema: 0001, the staging tables of 0002, the candidate show identity of 0003 (ADR-0025) and the
// projection checkpoint of 0004 (ADR 0056). A table a migration creates only to rename it over an older one is not one of its objects.
export const SCHEMA_MIGRATIONS=['migrations/0001_schema_v1.sql','migrations/0002_generation_stage.sql','migrations/0003_candidate_show_identity.sql','migrations/0004_projection_state.sql'];
export function schemaTables(){
 return [...new Set(SCHEMA_MIGRATIONS.flatMap(file=>{const text=fs.readFileSync(path.join(REPO_ROOT,file),'utf8'),renamed=new Set([...text.matchAll(/ALTER TABLE ([a-z_0-9]+) RENAME TO/g)].map(match=>match[1]));return [...text.matchAll(/CREATE TABLE ([a-z_0-9]+)/g)].map(match=>match[1]).filter(name=>!renamed.has(name));}))].sort();
}
export const SCHEMA_VERSION=4;
export const STAGED_SCHEMA_VERSION=SCHEMA_VERSION;

// The database identity fence: the live database must be the configured one by uuid and name, carry the frozen schema, and its
// identity receipts must belong to this baseline lineage. A receipt from another database id is a conflict. The lineage only moves
// forward: the newest identity receipt (by the baseline's finishedAt, recorded as imported_at) is the high-water mark. Re-running
// that baseline is allowed; a baseline never imported and newer than the mark needs --delta; re-running an older baseline after a
// newer one, or importing a never-seen baseline older than the mark, is a rollback and is refused whatever the flags, because no
// reconciliation path back to an older baseline exists in this executor.
export async function verifyTargetIdentity(adapter,{databaseId,databaseName,aggregateSha256,baselineAt=null,delta=false,describe=true,staged=false}){
 const findings={databaseId,databaseName,described:null,schema:null,identityReceipts:[],baseline:null};
 if(describe){
  const described=await adapter.describe();
  findings.described=described;
  if(described.uuid!==databaseId||described.name!==databaseName)throw new BackfillStop('target_identity_mismatch',{expected:{databaseId,databaseName},actual:described});
 }
 const tables=(await adapter.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(row=>row.name);
 const missing=schemaTables().filter(name=>!tables.includes(name));
 findings.schema={tables:tables.length,missing};
 if(missing.length)throw new BackfillStop('schema_missing',{missing});
 const version=(await adapter.get('SELECT version FROM schema_contract WHERE id=1'))?.version??null;
 findings.schema.version=version;
 if(version!==SCHEMA_VERSION)throw new BackfillStop('schema_version_mismatch',{expected:SCHEMA_VERSION,actual:version});
 const receipts=await adapter.all('SELECT source_key,source_sha256,target_id,imported_at FROM import_receipt WHERE target_table=? ORDER BY imported_at',[IDENTITY_TARGET_TABLE]);
 findings.identityReceipts=receipts.map(row=>({sourceSha256:row.source_sha256,targetId:row.target_id,importedAt:row.imported_at}));
 const foreign=receipts.filter(row=>row.target_id!==databaseId);
 if(foreign.length)throw new BackfillStop('database_identity_conflict',{receipts:findings.identityReceipts});
 if(!receipts.length){findings.baseline='first_run';return findings;}
 const newestAt=receipts.reduce((max,row)=>row.imported_at>max?row.imported_at:max,'');
 const newest=[...new Set(receipts.filter(row=>row.imported_at===newestAt).map(row=>row.source_sha256))];
 if(newest.length>1)throw new BackfillStop('baseline_ambiguous',{newestAt,checksums:newest});
 const mark=newest[0],seen=receipts.some(row=>row.source_sha256===aggregateSha256);
 findings.highWater={sourceSha256:mark,importedAt:newestAt};
 if(mark===aggregateSha256){findings.baseline='same_baseline';return findings;}
 if(seen)throw new BackfillStop('baseline_rollback',{current:aggregateSha256,highWater:findings.highWater});
 if(baselineAt!=null&&!(baselineAt>newestAt))throw new BackfillStop('baseline_rollback',{current:aggregateSha256,baselineAt,highWater:findings.highWater});
 findings.baseline='changed_baseline';
 if(!delta)throw new BackfillStop('baseline_changed',{previous:[...new Set(receipts.map(row=>row.source_sha256))],current:aggregateSha256});
 return findings;
}
async function recordIdentity(adapter,{databaseId,aggregateSha256,importedAt}){
 await adapter.transaction(async()=>{await adapter.run('INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES (?,?,?,?,?) ON CONFLICT(source_key,source_sha256,target_table,target_id) DO NOTHING',[IDENTITY_SOURCE_KEY,aggregateSha256,IDENTITY_TARGET_TABLE,databaseId,importedAt]);});
}
export async function readAcknowledged(file){
 if(!file)return [];
 const parsed=JSON.parse(await readFile(file,'utf8'));
 if(!Array.isArray(parsed)||parsed.some(item=>!item||typeof item.sourceKey!=='string'||typeof item.targetId!=='string'||typeof item.reason!=='string'))throw new ExportError('configuration','The acknowledged list must be an array of {sourceKey,targetTable?,targetId,reason}');
 return parsed.map(item=>({sourceKey:item.sourceKey,targetTable:item.targetTable??null,targetId:item.targetId,reason:item.reason}));
}

// One bounded run. mode 'd1' writes to the configured target through the HTTP adapter after the identity fence and the atomicity
// probe; mode 'sqlite' is the dry-run against a local file with the same rules and report shape.
// stagedGeneration routes the programme generation unit through the staging tables of schema v2 (ADR-0021) instead of one request.
// The stage owner token is derived from the target database and the baseline, so a resumed run of the same baseline continues the
// stage and a run from another baseline cannot write into it.
export function stageOwner(databaseId,aggregateSha256){return createHash('sha256').update(['generation-stage',databaseId,aggregateSha256].join('\n')).digest('hex');}
const sha256Text=text=>createHash('sha256').update(text,'utf8').digest('hex');
export async function runBackfill({snapshot,mode,target=null,sqliteFile=null,fetchImpl=fetch,limit=null,delta=false,acknowledged=[],output,now=()=>new Date(),sleep=sleepFor,stagedGeneration=false,clock=()=>Date.now()}){
 const absoluteOutput=outsideRepository(output);
 await mkdir(absoluteOutput,{recursive:true,mode:0o700});
 const report={mode,startedAt:now().toISOString(),snapshot:null,target:null,probe:null,identity:null,result:null,status:null,stopReasons:[],staged:stagedGeneration?{generations:[],gate:null}:null};
 const stagedGate=()=>{if(!report.staged)return;const commits=report.staged.generations.filter(item=>item.commit?.ms!=null&&item.outcome==='committed');report.staged.gate={commitBudgetMs:PUBLISH_BUDGET_MS,commits:commits.length,slowestCommitMs:commits.length?Math.max(...commits.map(item=>item.commit.ms)):null,go:commits.every(item=>item.commit.withinBudget)};};
 const finish=async(status,extra={})=>{stagedGate();Object.assign(report,{status,finishedAt:now().toISOString()},extra);await writeFile(path.join(absoluteOutput,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;};
 try{
  const verified=await verifyProductionSnapshot(snapshot);
  report.snapshot={status:verified.status,objects:verified.objects,aggregateSha256:verified.aggregateSha256,source:verified.source,baselineIdentity:verified.baselineIdentity};
  if(verified.status!==STATUS_CONSISTENT)throw new BackfillStop('snapshot_not_consistent',{noGoReasons:verified.noGoReasons});
  const batch=await prepareImport(snapshot,{limit});
  report.discoveryArchive=batch.discoveryArchive??null;
  report.fingerprintVersions=batch.fingerprintVersions??null;
  if(!batch.production)throw new BackfillStop('snapshot_not_production',{});
  const refused=refusal(batch);
  if(refused)throw new BackfillStop(refused.stopReasons[0]||'refused',{blockers:refused.blockers});
  let db,probe=null,identityFindings;
  if(mode==='d1'){
   if(!target)throw new ExportError('configuration','A D1 target is required');
   const scratch=createD1Adapter({target,databaseId:target.scratchDatabaseId,fetchImpl,sleep});
   const scratchIdentity=await scratch.describe();
   if(scratchIdentity.uuid!==target.scratchDatabaseId||scratchIdentity.name===target.databaseName)throw new BackfillStop('scratch_identity_mismatch',{actual:scratchIdentity});
   probe=await probeAtomicity(scratch,{statements:target.maxBatchStatements,bytes:target.maxBatchBytes});
   report.probe={database:target.scratchDatabaseId,...probe};
   if(!probe.atomic)throw new BackfillStop('batch_not_atomic',probe);
   db=createD1Adapter({target,databaseId:target.databaseId,fetchImpl,sleep});
   identityFindings=await verifyTargetIdentity(db,{databaseId:target.databaseId,databaseName:target.databaseName,aggregateSha256:batch.aggregateSha256,baselineAt:batch.finishedAt,delta,staged:stagedGeneration});
   report.target={kind:'d1',databaseId:target.databaseId,databaseName:target.databaseName,endpoint:new URL(target.endpoint).host,endpointOverride:target.endpointOverride,limits:{maxBatchStatements:target.maxBatchStatements,maxBatchBytes:target.maxBatchBytes}};
  }else if(mode==='sqlite'){
   if(!sqliteFile)throw new ExportError('configuration','A SQLite file is required for the dry-run');
   const file=outsideRepository(sqliteFile);
   db=openSqlite(file);
   identityFindings=await verifyTargetIdentity(db,{databaseId:'sqlite:'+path.basename(file),databaseName:'dry-run',aggregateSha256:batch.aggregateSha256,baselineAt:batch.finishedAt,delta,describe:false,staged:stagedGeneration});
   report.target={kind:'sqlite',file};
  }else throw new ExportError('configuration','mode must be d1 or sqlite');
  report.identity=identityFindings;
  await recordIdentity(db,{databaseId:mode==='d1'?target.databaseId:identityFindings.databaseId,aggregateSha256:batch.aggregateSha256,importedAt:batch.finishedAt});
  const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
  if(stagedGeneration){
   const databaseId=mode==='d1'?target.databaseId:identityFindings.databaseId;
   const limits=mode==='d1'?{maxStatements:Math.min(DEFAULT_CHUNK_STATEMENTS,target.maxBatchStatements),maxBytes:Math.min(DEFAULT_CHUNK_BYTES,target.maxBatchBytes)}:{};
   const options={owner:stageOwner(databaseId,batch.aggregateSha256),baseline:batch.aggregateSha256,sha256:sha256Text,now:()=>now().toISOString(),clock,limits,report:report.staged.generations};
   report.staged.limits={maxStatements:limits.maxStatements??DEFAULT_CHUNK_STATEMENTS,maxBytes:limits.maxBytes??DEFAULT_CHUNK_BYTES};
   repositories.epg={...repositories.epg,publishGeneration:input=>publishStaged(db,input,options)};
  }
  let result;
  try{result=await importBatch(db,repositories,{...batch,importedAt:batch.finishedAt,shas:{...batch.shas,[IDENTITY_SOURCE_KEY]:batch.aggregateSha256},stopOn:{conflicts:true,unacknowledged:true},acknowledged});}
  catch(error){
   if(error instanceof StageStop)throw new BackfillStop(error.reason,error.details);
   if(error instanceof D1Error&&['write_uncertain','batch_too_large','statement'].includes(error.kind))throw new BackfillStop(error.kind,{message:error.message,...error.details});
   throw error;
  }
  report.result={...result,adapter:db.stats||null};
  await writeFile(path.join(absoluteOutput,'ledger.json'),JSON.stringify({aggregateSha256:batch.aggregateSha256,classC:result.classes.C.records,superseded:result.classes.S.records,ledger:result.ledger},null,2)+'\n',{mode:0o600});
  report.stopReasons=result.stopReasons;
  return await finish(result.stopped?'stopped':result.pending>0?'partial':'completed');
 }catch(error){
  if(error instanceof BackfillStop){report.stopReasons=[error.reason];return await finish('no_go',{noGo:{reason:error.reason,details:error.details}});}
  // An uncertain or oversized write anywhere in the run (identity receipt, probe, unit) is a NO-GO with a report, never a silent retry.
  if(error instanceof D1Error&&['write_uncertain','batch_too_large','statement'].includes(error.kind)){report.stopReasons=[error.kind];return await finish('no_go',{noGo:{reason:error.kind,details:{message:error.message,...error.details}}});}
  throw error;
 }
}
// Owner-approved, bounded cleanup of one failed or superseded stage. It deletes staging rows only, never a final row, and refuses
// any other stage state. It is never part of a backfill run.
export async function runStageCleanup({mode,target=null,sqliteFile=null,fetchImpl=fetch,programmeRunId,approved=false,abandon=false,limit=500,output,now=()=>new Date(),sleep=sleepFor}){
 if(approved!==true)throw new ExportError('configuration','Stage cleanup needs the explicit --cleanup-approved flag');
 if(!programmeRunId)throw new ExportError('configuration','A programme run id is required');
 const absoluteOutput=outsideRepository(output);
 await mkdir(absoluteOutput,{recursive:true,mode:0o700});
 const report={mode,action:abandon?'abandon_and_discard_stage':'discard_stage',programmeRunId,startedAt:now().toISOString(),target:null,result:null,status:null};
 const finish=async(status,extra={})=>{Object.assign(report,{status,finishedAt:now().toISOString()},extra);await writeFile(path.join(absoluteOutput,'cleanup.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;};
 try{
  let db;
  if(mode==='d1'){
   db=createD1Adapter({target,databaseId:target.databaseId,fetchImpl,sleep});
   const described=await db.describe();
   if(described.uuid!==target.databaseId||described.name!==target.databaseName)throw new BackfillStop('target_identity_mismatch',{actual:described});
   report.target={kind:'d1',databaseId:target.databaseId,databaseName:target.databaseName};
  }else if(mode==='sqlite'){db=openSqlite(outsideRepository(sqliteFile));report.target={kind:'sqlite',file:sqliteFile};}
  else throw new ExportError('configuration','mode must be d1 or sqlite');
  const tables=(await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name);
  const missing=STAGE_TABLES.filter(name=>!tables.includes(name));
  if(missing.length)throw new BackfillStop('schema_missing',{missing});
  report.result=await discardStage(db,programmeRunId,{limit,abandon,now:()=>now().toISOString()});
  return await finish('completed');
 }catch(error){
  if(error instanceof StageStop||error instanceof BackfillStop)return await finish('no_go',{noGo:{reason:error.reason,details:error.details}});
  if(error instanceof D1Error&&['write_uncertain','statement'].includes(error.kind))return await finish('no_go',{noGo:{reason:error.kind,details:{message:error.message}}});
  throw error;
 }
}
function outsideRepository(directory){
 if(!directory||!path.isAbsolute(directory))throw new ExportError('configuration','Output and database paths must be absolute and outside the Git repository');
 const absolute=path.resolve(directory);
 if(absolute===REPO_ROOT||absolute.startsWith(REPO_ROOT+path.sep))throw new ExportError('configuration','Output and database paths must be absolute and outside the Git repository');
 return absolute;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?null:args[index+1];};
 const snapshot=value('--snapshot'),output=value('--output'),mode=value('--target'),sqliteFile=value('--database'),limitText=value('--limit'),acknowledgedFile=value('--acknowledged');
 const limit=limitText==null?null:Number(limitText);
 const discard=value('--discard-stage');
 if(discard!=null){
  if(!output||!['d1','sqlite'].includes(mode)){console.error('Usage: node scripts/d1-backfill.mjs --discard-stage <programmeRunId> --cleanup-approved [--abandon] --output /absolute/private/run --target d1|sqlite [--database /absolute/private/dry-run.sqlite]');process.exit(2);}
  try{
   const report=await runStageCleanup({mode,target:mode==='d1'?readTarget(process.env):null,sqliteFile,programmeRunId:discard,approved:args.includes('--cleanup-approved'),abandon:args.includes('--abandon'),output});
   console.log(JSON.stringify(report));
   process.exitCode=report.status==='completed'?0:3;
  }catch(error){
   if(error instanceof ExportError){console.error(error.kind+': '+error.message);process.exitCode=error.kind==='configuration'?2:1;}
   else{console.error('Stage cleanup failed');process.exitCode=1;}
  }
 }else{
  if(!snapshot||!path.isAbsolute(snapshot)||!output||!['d1','sqlite'].includes(mode)||(limit!=null&&!(Number.isInteger(limit)&&limit>0))){console.error('Usage: node scripts/d1-backfill.mjs --snapshot /absolute/private/snapshot --output /absolute/private/run --target d1|sqlite [--database /absolute/private/dry-run.sqlite] [--limit <units>] [--delta] [--staged-generation] [--acknowledged /absolute/private/class-c.json]');process.exit(2);}
  try{
   const target=mode==='d1'?readTarget(process.env):null;
   const report=await runBackfill({snapshot,mode,target,sqliteFile,limit,delta:args.includes('--delta'),acknowledged:await readAcknowledged(acknowledgedFile),output,stagedGeneration:args.includes('--staged-generation')});
   console.log(JSON.stringify(report));
   process.exitCode=report.status==='completed'?0:3;
  }catch(error){
   if(error instanceof ExportError||error instanceof SnapshotError){console.error((error.kind||'snapshot')+': '+error.message);process.exitCode=error instanceof ExportError&&error.kind==='configuration'?2:1;}
   else{console.error('Backfill failed');process.exitCode=1;}
  }
 }
}
