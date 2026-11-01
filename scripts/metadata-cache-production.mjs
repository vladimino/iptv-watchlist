#!/usr/bin/env node
// Production entry for the metadata cache cutover (ADR 0073). Default is read-only.
// --apply sends only migrations/0006_metadata_cache.sql. --load copies the live metadata.json
// into D1 and leaves mode r2. --activate flips the marker r2 to d1. Each write needs its own
// --confirm and --target iptv. This script refuses --revert, never writes R2, and never calls
// Time Travel restore. It does not replace scripts/metadata-cache-authority.mjs, which stays
// offline and still refuses the production database.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {activateMetadataCache, importMetadataCache} from '../src/metadata-cache.js';
import {createD1Adapter, D1Error, endpointFor, renderSql} from './d1-backfill.mjs';
import {ExportError} from './migration-export.mjs';
import {createReadOnlyClient, readCredentials} from './r2-snapshot-export.mjs';

export const PRODUCTION_ACCOUNT_ID='8d9331889a693d328ef306692adf9d24';
export const PRODUCTION_DATABASE_ID='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb';
export const PRODUCTION_DATABASE_NAME='iptv';
export const STATEMENT_BYTES=100*1024;
export const BATCH_STATEMENTS=2000;
export const BATCH_BYTES=8*1024*1024;
const CACHE_TABLES=['metadata_cache','metadata_cache_authority','metadata_cache_cas'];
const WRITER_WINDOW_MS=15*60*1000;
const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const MIGRATION_PATH=path.join(ROOT,'migrations/0006_metadata_cache.sql');

export class OperatorStop extends Error{
 constructor(reason, exit=3, details={}){
  super(reason);
  this.name='OperatorStop';
  this.reason=reason;
  this.exit=exit;
  this.details=details;
 }
}

export function migrationStatements(text){
 const source=String(text).split('\n').filter(line=>!/^\s*--/.test(line)).join('\n');
 const statements=[];
 let current='', quote=false;
 for(let index=0;index<source.length;index++){
  const character=source[index];
  if(character==="'"){
   if(quote&&source[index+1]==="'"){current+="''";index++;continue;}
   quote=!quote;
   current+=character;
   continue;
  }
  if(character===';'&&!quote){
   const sql=current.trim();
   if(sql)statements.push(sql);
   current='';
   continue;
  }
  current+=character;
 }
 const tail=current.trim();
 if(tail)statements.push(tail);
 return statements;
}

export function createCacheBinding(adapter){
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
   if(texts.length>BATCH_STATEMENTS||bytes>BATCH_BYTES)throw new OperatorStop('batch_too_large',3);
   await adapter.executeRendered(texts);
  },
 };
}

// Proves the changes() fence on the scratch database only. A batch whose fence matches nothing
// must roll back the insert from that same batch. Production is not written when this fails.
export async function proveCacheFence(adapter){
 const drop=()=>adapter.executeRendered([
  'DROP TABLE IF EXISTS metadata_cache_fence_probe',
  'DROP TABLE IF EXISTS metadata_cache_fence_cas',
 ]);
 await drop();
 await adapter.executeRendered([
  'CREATE TABLE metadata_cache_fence_probe (id INTEGER PRIMARY KEY)',
  'CREATE TABLE metadata_cache_fence_cas (id INTEGER PRIMARY KEY CHECK (id = 1), ok INTEGER NOT NULL CHECK (ok = 1))',
  'INSERT INTO metadata_cache_fence_cas (id, ok) VALUES (1, 1)',
 ]);
 let failure=null;
 try{
  await adapter.executeRendered([
   'INSERT INTO metadata_cache_fence_probe (id) VALUES (1)',
   'UPDATE metadata_cache_fence_cas SET ok=changes() WHERE id=1',
  ]);
  const applied=Number((await adapter.get('SELECT COUNT(*) AS n FROM metadata_cache_fence_probe'))?.n);
  if(applied!==1)throw new OperatorStop('fence_not_atomic',3);
  let failed=false;
  try{
   await adapter.executeRendered([
    'INSERT INTO metadata_cache_fence_probe (id) VALUES (2)',
    'UPDATE metadata_cache_fence_probe SET id=id WHERE 0',
    'UPDATE metadata_cache_fence_cas SET ok=changes() WHERE id=1',
   ]);
  }catch(error){
   failed=error instanceof D1Error&&error.kind==='statement';
   if(!failed)throw error;
  }
  const remaining=Number((await adapter.get('SELECT COUNT(*) AS n FROM metadata_cache_fence_probe'))?.n);
  if(!failed||remaining!==1)throw new OperatorStop('fence_not_atomic',3);
 }catch(error){failure=error;}
 try{await drop();}catch(error){if(!failure)failure=error;}
 if(failure)throw failure;
}

function parseArgs(argv){
 const args=argv.slice(2);
 const value=name=>{
  const index=args.indexOf(name);
  if(index<0)return undefined;
  const next=args[index+1];
  if(next===undefined||next.startsWith('--'))throw new OperatorStop('usage',2);
  return next;
 };
 const commands=['--apply','--load','--activate','--revert'].filter(name=>args.includes(name));
 if(commands.length>1)throw new OperatorStop('usage',2);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(arg==='--target'||arg==='--confirm'){value(arg);index++;continue;}
  if(!commands.includes(arg))throw new OperatorStop('usage',2);
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(command==='revert')throw new OperatorStop('revert_refused',2);
 const target=args.includes('--target')?value('--target'):undefined;
 const confirm=args.includes('--confirm')?value('--confirm'):undefined;
 if(target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='apply'&&confirm!=='apply')throw new OperatorStop('confirm',2);
 if(command==='load'&&confirm!=='load')throw new OperatorStop('confirm',2);
 if(command==='activate'&&confirm!=='activate')throw new OperatorStop('confirm',2);
 if(command==='status'&&confirm!==undefined)throw new OperatorStop('usage',2);
 return {command, confirm};
}

function productionTarget(env){
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim();
 const apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 const configuredId=String(env.D1_BACKFILL_DATABASE_ID||'').trim();
 const scratchDatabaseId=String(env.D1_BACKFILL_SCRATCH_DATABASE_ID||'').trim();
 if(!/^[0-9a-f]{32}$/.test(accountId)||!apiToken)throw new OperatorStop('configuration',2);
 if(accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(configuredId&&configuredId!==PRODUCTION_DATABASE_ID)throw new OperatorStop('database_id_mismatch',3);
 let endpoint;
 try{endpoint=endpointFor(env.D1_BACKFILL_ENDPOINT);}catch(error){throw normalize(error);}
 return {accountId, apiToken, endpoint, scratchDatabaseId, maxBatchStatements:BATCH_STATEMENTS, maxBatchBytes:BATCH_BYTES};
}

function requireScratch(target){
 const scratchDatabaseId=target.scratchDatabaseId;
 if(!/^[0-9a-f-]{36}$/.test(scratchDatabaseId))throw new OperatorStop('configuration',2);
 if(scratchDatabaseId===PRODUCTION_DATABASE_ID)throw new OperatorStop('database_id_mismatch',3);
 return scratchDatabaseId;
}

function normalize(error){
 if(error instanceof OperatorStop)return error;
 let current=error;
 for(let depth=0;depth<6&&current;depth++){
  if(current instanceof D1Error&&current.kind==='write_uncertain')return new OperatorStop('write_uncertain',3);
  current=current.cause;
 }
 if(error instanceof D1Error){
  if(error.kind==='authorization')return new OperatorStop('authorization',3);
  if(error.kind==='batch_too_large')return new OperatorStop('batch_too_large',3);
  if(error.kind==='network')return new OperatorStop('network',1);
  if(error.kind==='statement')return new OperatorStop('statement_failed',3);
  return new OperatorStop('request_failed',3);
 }
 if(error instanceof ExportError||error?.name==='ExportError'){
  if(error.kind==='configuration')return new OperatorStop('configuration',2);
  if(error.kind==='source_changed')return new OperatorStop('source_changed',3);
  if(error.kind==='authorization')return new OperatorStop('authorization',3);
  return new OperatorStop(error.kind||'source_failed',3);
 }
 if(typeof error?.code==='string'&&error.code.startsWith('metadata_cache_'))return new OperatorStop(error.code,3);
 return new OperatorStop('failed',1);
}

async function readBookmark(target, fetchImpl){
 const url=target.endpoint+'/accounts/'+target.accountId+'/d1/database/'+PRODUCTION_DATABASE_ID+'/time_travel/bookmark';
 let response;
 try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:'Bearer '+target.apiToken},redirect:'error'});}
 catch{throw new OperatorStop('bookmark_unavailable',3);}
 if(response.status===401||response.status===403)throw new OperatorStop('authorization',3);
 let payload=null;
 try{payload=await response.json();}catch{payload=null;}
 const bookmark=payload?.result?.bookmark??payload?.bookmark??null;
 if(!response.ok||typeof bookmark!=='string'||!bookmark)throw new OperatorStop('bookmark_unavailable',3);
 return bookmark;
}

async function readSnapshot(binding){
 try{
  const versionRow=await binding.prepare('SELECT version FROM schema_contract WHERE id=1').bind().first();
  const version=Number(versionRow?.version);
  const names=(await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metadata_cache','metadata_cache_authority','metadata_cache_cas')").bind().all()).results.map(row=>row.name);
  const tables=Object.fromEntries(CACHE_TABLES.map(name=>[name,names.includes(name)]));
  let marker=null, cacheRows=null;
  if(tables.metadata_cache_authority){
   const row=await binding.prepare('SELECT mode, cache_generation AS cacheGeneration, mirror_generation AS mirrorGeneration, mirror_etag AS mirrorEtag FROM metadata_cache_authority WHERE id=1').bind().first();
   if(row)marker={mode:row.mode, cacheGeneration:Number(row.cacheGeneration), mirrorGeneration:Number(row.mirrorGeneration), mirrorEtag:row.mirrorEtag??null};
  }
  if(tables.metadata_cache)cacheRows=Number((await binding.prepare('SELECT COUNT(*) AS n FROM metadata_cache').bind().first())?.n);
  return {schemaVersion:Number.isFinite(version)?version:null, tables, marker, cacheRows};
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}

function r2State(env){
 const accountId=String(env.R2_SNAPSHOT_ACCOUNT_ID||'').trim();
 const accessKeyId=String(env.R2_SNAPSHOT_ACCESS_KEY_ID||'').trim();
 const secretAccessKey=String(env.R2_SNAPSHOT_SECRET_ACCESS_KEY||'').trim();
 const bucket=String(env.R2_SNAPSHOT_BUCKET||'').trim();
 if(!accountId&&!accessKeyId&&!secretAccessKey&&!bucket)return null;
 let credentials;
 try{credentials=readCredentials(env);}catch(error){throw normalize(error);}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 return credentials;
}

async function readObject(client, key, {required=true}={}){
 let head;
 try{head=await client.head(key);}catch(error){throw normalize(error);}
 if(!head){if(required)throw new OperatorStop('source_missing',3);return null;}
 let got;
 try{got=await client.get(key,{ifMatch:head.etag});}catch(error){throw normalize(error);}
 if(!got)throw new OperatorStop('source_missing',3);
 const bytes=Buffer.from(await new Response(got.body).arrayBuffer());
 if(bytes.length!==head.size)throw new OperatorStop('source_changed',3);
 let again;
 try{again=await client.head(key,{ifMatch:head.etag});}catch(error){throw normalize(error);}
 if(!again||again.etag!==head.etag||again.size!==head.size)throw new OperatorStop('source_changed',3);
 return {key, etag:head.etag, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), text:bytes.toString('utf8')};
}

function parseRecord(text, key){
 try{
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('shape');
  return value;
 }catch{throw new OperatorStop('source_invalid',3,{key});}
}

async function writerReport(client, binding, now){
 const sync=await readObject(client,'sync.json',{required:false});
 const lease=await readObject(client,'epg/resolver-lease.json',{required:false});
 let syncState='absent', resolverState='absent';
 if(sync){
  const value=parseRecord(sync.text,'sync.json');
  if(['metadata','epg'].includes(value.stage)){
   const updated=Date.parse(value.updatedAt);
   syncState=!Number.isFinite(updated)||now-updated<WRITER_WINDOW_MS?'active':'idle';
  }else syncState='idle';
 }
 if(lease){
  const value=parseRecord(lease.text,'epg/resolver-lease.json');
  resolverState=Number(value.expiresAt)>now?'active':'idle';
 }
 let row;
 try{row=await binding.prepare('SELECT lease_until AS leaseUntil FROM projection_run WHERE projection=?').bind('enrichment').first();}
 catch{throw new OperatorStop('unknown_state',3);}
 const projectionState=row?.leaseUntil&&Date.parse(row.leaseUntil)>now?'active':'idle';
 return {sync:syncState, resolver:resolverState, projection:projectionState};
}

function assertIdle(writers){
 if(writers.sync==='active'||writers.resolver==='active'||writers.projection==='active')throw new OperatorStop('writer_active',3,{writers});
}

function sourceSummary(object){
 const value=parseRecord(object.text, object.key);
 return {etag:object.etag, bytes:object.bytes, sha256:object.sha256, keys:Object.keys(value).length};
}

function mirrorBucket(client, captured){
 return {
  async get(){
   return {etag:captured.etag, json:async()=>parseRecord(captured.text,'metadata.json'), text:async()=>captured.text};
  },
  async head(){
   const head=await client.head('metadata.json',{ifMatch:captured.etag});
   return head?{etag:head.etag}:null;
  },
  async put(){throw new OperatorStop('r2_write_refused',3);},
 };
}

// A production write is unknown from the moment the request is sent until the response
// returns. A later read-back failure does not change a returned request back to "no write".
function trackProductionWrites(adapter, ctx){
 async function attempt(run){
  ctx.writeState='unknown';
  await run();
  ctx.writeState='committed';
 }
 return {
  stats:adapter.stats,
  describe:()=>adapter.describe(),
  get:(sql,params)=>adapter.get(sql,params),
  all:(sql,params)=>adapter.all(sql,params),
  run:(sql,params)=>attempt(()=>adapter.run(sql,params)),
  executeRendered:statements=>attempt(()=>adapter.executeRendered(statements)),
 };
}

async function openProduction(env, fetchImpl, ctx){
 const target=productionTarget(env);
 const adapter=trackProductionWrites(createD1Adapter({target, databaseId:PRODUCTION_DATABASE_ID, fetchImpl}), ctx);
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
 return {target, adapter, binding:createCacheBinding(adapter)};
}

async function openScratch(target, fetchImpl){
 const scratchDatabaseId=requireScratch(target);
 const adapter=createD1Adapter({target, databaseId:scratchDatabaseId, fetchImpl});
 const described=await adapter.describe();
 if(described.uuid!==scratchDatabaseId||described.uuid===PRODUCTION_DATABASE_ID||described.name===PRODUCTION_DATABASE_NAME)throw new OperatorStop('scratch_identity_mismatch',3);
 return adapter;
}

function tablesPresent(snapshot){
 return CACHE_TABLES.every(name=>snapshot.tables[name]);
}
function tablesAbsent(snapshot){
 return CACHE_TABLES.every(name=>!snapshot.tables[name]);
}

function writeReport(ctx){
 const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
 if(writeState==='committed')return {writeState, writes:true, retry:false};
 if(writeState==='unknown')return {writeState, writes:null, retry:false};
 return {writeState, writes:false};
}

async function finish(stop, ctx){
 const result={reason:stop.reason, ...writeReport(ctx)};
 if(stop.details?.writers)result.writers=stop.details.writers;
 if(ctx.bookmark)result.bookmark=ctx.bookmark;
 if(ctx.identified&&ctx.binding&&stop.exit!==2){
  try{result.readback=await readSnapshot(ctx.binding);}catch{result.readback={unknown:true};}
 }
 return {exit:stop.exit, result};
}

export async function runMetadataCacheProduction({argv=process.argv, env=process.env, fetchImpl=globalThis.fetch, now=()=>Date.now()}={}){
 const ctx={bookmark:null, binding:null, identified:false, writeState:'none'};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0, result:parsed.report};
  const opened=await openProduction(env, fetchImpl, ctx);
  ctx.binding=opened.binding;
  ctx.identified=true;
  ctx.bookmark=await readBookmark(opened.target, fetchImpl);
  const clock=typeof now==='function'?now():now;
  const snapshot=await readSnapshot(opened.binding);
  const credentials=r2State(env);
  const client=credentials?createReadOnlyClient({credentials, fetchImpl}):null;
  if(parsed.command==='status')return {exit:0, result:await statusResult(ctx, snapshot, client, opened.binding, clock)};
  if(!client)throw new OperatorStop('source_missing',3);
  const writers=await writerReport(client, opened.binding, clock);
  assertIdle(writers);
  const metadata=await readObject(client,'metadata.json');
  const source=sourceSummary(metadata);
  if(parsed.command==='apply')return {exit:0, result:await applyMigration(opened, ctx, snapshot, source)};
  if(snapshot.schemaVersion!==6||!tablesPresent(snapshot)||!snapshot.marker)throw new OperatorStop('metadata_cache_schema',3);
  if(snapshot.marker.mode!=='r2')throw new OperatorStop('metadata_cache_authoritative',3);
  if(parsed.command==='activate'){
   if(snapshot.marker.cacheGeneration!==snapshot.marker.mirrorGeneration||metadata.etag!==snapshot.marker.mirrorEtag)throw new OperatorStop('metadata_cache_fence',3);
  }
  const scratch=await openScratch(opened.target, fetchImpl);
  await proveCacheFence(scratch);
  if(parsed.command==='load')return {exit:0, result:await loadCache(opened.binding, client, metadata, source, ctx, snapshot)};
  return {exit:0, result:await activateCache(opened.binding, client, metadata, source, ctx, snapshot)};
 }catch(error){
  return finish(normalize(error), ctx);
 }
}

async function statusResult(ctx, snapshot, client, binding, clock){
 const partial=snapshot.schemaVersion===6&&(!tablesPresent(snapshot)||!snapshot.marker||(snapshot.marker.mode!=='r2'&&snapshot.marker.mode!=='d1'));
 if(partial)throw new OperatorStop('partial_schema',3);
 if(!client)return {configured:true, writes:false, writeState:'none', bookmark:ctx.bookmark, schemaVersion:snapshot.schemaVersion, tables:snapshot.tables, marker:snapshot.marker, cacheRows:snapshot.cacheRows, r2:'not_configured'};
 const writers=await writerReport(client, binding, clock);
 assertIdle(writers);
 const metadata=await readObject(client,'metadata.json',{required:false});
 if(!metadata)throw new OperatorStop('source_missing',3,{writers});
 return {configured:true, writes:false, writeState:'none', bookmark:ctx.bookmark, schemaVersion:snapshot.schemaVersion, tables:snapshot.tables, marker:snapshot.marker, cacheRows:snapshot.cacheRows, writers, r2:{bucket:PRODUCTION_DATABASE_NAME, metadata:sourceSummary(metadata)}};
}

async function applyMigration(opened, ctx, snapshot, source){
 const anyPresent=CACHE_TABLES.some(name=>snapshot.tables[name]);
 if(snapshot.schemaVersion===6&&!tablesPresent(snapshot))throw new OperatorStop('partial_schema',3);
 if(anyPresent&&!tablesPresent(snapshot))throw new OperatorStop('partial_schema',3);
 if(tablesPresent(snapshot))throw new OperatorStop('already_applied',3);
 if(snapshot.schemaVersion!==5||!tablesAbsent(snapshot))throw new OperatorStop('schema_unexpected',3);
 const statements=migrationStatements(fs.readFileSync(MIGRATION_PATH,'utf8'));
 if(!statements.length||statements.some(sql=>/\bfilm_sync_state\b|\bINSERT\s+INTO\s+film\b/i.test(sql)))throw new OperatorStop('migration_refused',3);
 await opened.adapter.executeRendered(statements);
 const readback=await readSnapshot(opened.binding);
 if(readback.schemaVersion!==6||readback.marker?.mode!=='r2'||readback.marker.cacheGeneration!==0||readback.marker.mirrorGeneration!==0||readback.cacheRows!==0)throw new OperatorStop('readback_mismatch',3);
 return {operation:'apply', writes:true, writeState:'committed', bookmark:ctx.bookmark, source, schemaVersion:readback.schemaVersion, mode:readback.marker.mode, cacheGeneration:readback.marker.cacheGeneration, mirrorGeneration:readback.marker.mirrorGeneration, cacheRows:readback.cacheRows};
}

async function loadCache(binding, client, metadata, source, ctx, snapshot){
 if(snapshot.schemaVersion!==6||!tablesPresent(snapshot)||!snapshot.marker)throw new OperatorStop('metadata_cache_schema',3);
 if(snapshot.marker.mode!=='r2')throw new OperatorStop('metadata_cache_authoritative',3);
 const imported=await importMetadataCache(binding, mirrorBucket(client, metadata), {confirm:'load'});
 let head;
 try{head=await client.head('metadata.json',{ifMatch:imported.mirrorEtag});}
 catch(error){
  if(error instanceof ExportError&&error.kind==='source_changed')throw new OperatorStop('mirror_moved',3);
  throw error;
 }
 if(!head||head.etag!==imported.mirrorEtag)throw new OperatorStop('mirror_moved',3);
 const readback=await readSnapshot(binding);
 if(readback.marker?.mode!=='r2'||readback.marker.cacheGeneration!==imported.cacheGeneration||readback.marker.mirrorGeneration!==imported.mirrorGeneration||readback.marker.mirrorEtag!==imported.mirrorEtag||readback.cacheRows!==imported.keys)throw new OperatorStop('readback_mismatch',3);
 return {operation:'load', writes:true, writeState:'committed', bookmark:ctx.bookmark, source, mode:'r2', keys:imported.keys, cacheGeneration:imported.cacheGeneration, mirrorGeneration:imported.mirrorGeneration, mirrorEtag:imported.mirrorEtag, cacheRows:readback.cacheRows};
}

async function activateCache(binding, client, metadata, source, ctx, snapshot){
 if(snapshot.schemaVersion!==6||!tablesPresent(snapshot)||!snapshot.marker)throw new OperatorStop('metadata_cache_schema',3);
 if(snapshot.marker.mode!=='r2')throw new OperatorStop('metadata_cache_authoritative',3);
 if(snapshot.marker.cacheGeneration!==snapshot.marker.mirrorGeneration)throw new OperatorStop('metadata_cache_fence',3);
 if(metadata.etag!==snapshot.marker.mirrorEtag)throw new OperatorStop('metadata_cache_fence',3);
 const after=await activateMetadataCache(binding, mirrorBucket(client, metadata), {confirm:'activate'});
 const readback=await readSnapshot(binding);
 if(after.mode!=='d1'||readback.marker?.mode!=='d1'||readback.marker.cacheGeneration!==snapshot.marker.cacheGeneration)throw new OperatorStop('readback_mismatch',3);
 return {operation:'activate', writes:true, writeState:'committed', bookmark:ctx.bookmark, source, mode:'d1', cacheGeneration:readback.marker.cacheGeneration, mirrorGeneration:readback.marker.mirrorGeneration, cacheRows:readback.cacheRows};
}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 runMetadataCacheProduction().then(({exit, result})=>{
  process.stdout.write(JSON.stringify(result)+'\n');
  if(exit===2)process.stderr.write('refuse: '+result.reason+'\n');
  else if(exit===3)process.stderr.write('no-go: '+result.reason+(result.writeState==='unknown'?'; read back, do not retry':result.writeState==='committed'?'; the write returned, read back before another command':'')+'\n');
  else if(exit!==0)process.stderr.write('error: '+result.reason+'\n');
  process.exit(exit);
 }).catch(()=>{process.stderr.write('error: failed\n');process.exit(1);});
}
