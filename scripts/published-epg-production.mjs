#!/usr/bin/env node
// Production entry for the published EPG cutover (ADR 0078). Default is read-only.
// --apply sends only migrations/0008_published_epg_authority.sql, and only when the
// contract version is 6 or 7 and the published EPG tables are all absent. The inserted
// marker stays mode r2. --load copies the live programme and watchlist into D1 and
// leaves mode r2. --activate flips the marker r2 to d1. Each write needs its own
// --confirm and --target iptv. This script refuses --revert, never writes R2, and
// never calls Time Travel restore. The D1 token is sent only to
// https://api.cloudflare.com/client/v4, and only for database iptv.
// It does not replace scripts/published-epg-authority.mjs, which stays offline and
// still refuses the production database. A Worker batch and this REST batch are
// different transports; this script does not prove the Worker publisher's atomicity.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {activatePublished, importPublished} from '../src/published-epg.js';
import {createD1Adapter, D1Error, DEFAULT_ENDPOINT, renderSql} from './d1-backfill.mjs';
import {ExportError} from './migration-export.mjs';
import {createReadOnlyClient, readCredentials} from './r2-snapshot-export.mjs';

export const PRODUCTION_ACCOUNT_ID='8d9331889a693d328ef306692adf9d24';
export const PRODUCTION_DATABASE_ID='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb';
export const PRODUCTION_DATABASE_NAME='iptv';
export const STATEMENT_BYTES=100*1024;
export const BATCH_STATEMENTS=2000;
export const BATCH_BYTES=8*1024*1024;
const TABLES=['published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'];
const WRITER_WINDOW_MS=15*60*1000;
const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const MIGRATION_PATH=path.join(ROOT,'migrations/0008_published_epg_authority.sql');

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

export function publishedEpgStatements(){
 const statements=migrationStatements(fs.readFileSync(MIGRATION_PATH,'utf8'));
 if(!statements.length||statements.some(sql=>/\bBEGIN\b|\bCOMMIT\b|\bINTO\s+film\b|\bINTO\s+candidate\b|\bprediction_|\bwatchlist_film\b/i.test(sql)))throw new OperatorStop('migration_refused',3);
 return statements;
}

export function applyDecision(snapshot){
 const version=Number(snapshot.schemaVersion);
 const present=TABLES.filter(name=>snapshot.tables[name]);
 if(present.length===TABLES.length)return 'already_applied';
 if(present.length||version>=8)return 'partial_schema';
 if(version!==6&&version!==7)return 'schema_unexpected';
 return 'apply';
}

export function createPublishedBinding(adapter){
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
 if(!/^[0-9a-f]{32}$/.test(accountId)||!apiToken)throw new OperatorStop('configuration',2);
 if(accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(configuredId&&configuredId!==PRODUCTION_DATABASE_ID)throw new OperatorStop('database_id_mismatch',3);
 return {accountId, apiToken, endpoint:productionEndpoint(env), maxBatchStatements:BATCH_STATEMENTS, maxBatchBytes:BATCH_BYTES};
}

function productionEndpoint(env){
 const value=String(env.D1_BACKFILL_ENDPOINT||'').trim();
 if(!value)return DEFAULT_ENDPOINT;
 let url;
 try{url=new URL(value);}catch{throw new OperatorStop('endpoint_refused',3);}
 if(url.username||url.password||url.search||url.hash)throw new OperatorStop('endpoint_refused',3);
 const endpoint=url.origin+url.pathname.replace(/\/$/,'');
 if(endpoint!==DEFAULT_ENDPOINT)throw new OperatorStop('endpoint_refused',3);
 return endpoint;
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
 if(typeof error?.code==='string'&&error.code.startsWith('published_epg_'))return new OperatorStop(error.code,3);
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
  const names=(await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'published_epg%'").bind().all()).results.map(row=>row.name);
  const tables=Object.fromEntries(TABLES.map(name=>[name,names.includes(name)]));
  let marker=null;
  if(tables.published_epg_authority){
   const row=await binding.prepare('SELECT mode, programme_run_id AS programmeRunId, generation, mirror_programme_run_id AS mirrorProgrammeRunId, mirror_etag AS mirrorEtag, watchlist_generation AS watchlistGeneration FROM published_epg_authority WHERE id=1').bind().first();
   if(row)marker={mode:row.mode, programmeRunId:row.programmeRunId??null, generation:Number(row.generation), mirrorProgrammeRunId:row.mirrorProgrammeRunId??null, mirrorEtag:row.mirrorEtag??null, watchlistGeneration:Number(row.watchlistGeneration)};
  }
  return {schemaVersion:Number.isFinite(version)?version:null, tables, marker};
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
 return {key, etag:head.etag, bytes:bytes.length, text:bytes.toString('utf8')};
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
 return {target, adapter, binding:createPublishedBinding(adapter)};
}

function tablesPresent(snapshot){
 return TABLES.every(name=>snapshot.tables[name]);
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

export async function runPublishedEpgProduction({argv=process.argv, env=process.env, fetchImpl=globalThis.fetch, now=()=>Date.now()}={}){
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
  if(parsed.command==='apply')return {exit:0, result:await applyMigration(opened, ctx, snapshot, writers)};
  const source=await readPublished(client);
  if(!tablesPresent(snapshot)||!(Number(snapshot.schemaVersion)>=8)||!snapshot.marker)throw new OperatorStop('published_epg_schema',3);
  if(snapshot.marker.mode!=='r2')throw new OperatorStop('published_epg_authoritative',3);
  if(parsed.command==='load')return {exit:0, result:await loadPublished(opened.binding, source, ctx)};
  if(snapshot.marker.mirrorProgrammeRunId!==snapshot.marker.programmeRunId||source.pointer.etag!==snapshot.marker.mirrorEtag)throw new OperatorStop('published_epg_fence',3);
  return {exit:0, result:await activateMarker(opened.binding, source, ctx, snapshot)};
 }catch(error){
  return finish(normalize(error), ctx);
 }
}

async function statusResult(ctx, snapshot, client, binding, clock){
 if(applyDecision(snapshot)==='partial_schema')throw new OperatorStop('partial_schema',3);
 if(!client)return {configured:true, writes:false, writeState:'none', bookmark:ctx.bookmark, schemaVersion:snapshot.schemaVersion, tables:snapshot.tables, marker:snapshot.marker, r2:'not_configured'};
 const writers=await writerReport(client, binding, clock);
 assertIdle(writers);
 return {configured:true, writes:false, writeState:'none', bookmark:ctx.bookmark, schemaVersion:snapshot.schemaVersion, tables:snapshot.tables, marker:snapshot.marker, writers, r2:{bucket:PRODUCTION_DATABASE_NAME}};
}

async function applyMigration(opened, ctx, snapshot, writers){
 const decision=applyDecision(snapshot);
 if(decision!=='apply')throw new OperatorStop(decision,3,{writers});
 const statements=publishedEpgStatements();
 await opened.adapter.executeRendered(statements);
 const readback=await readSnapshot(opened.binding);
 if(readback.schemaVersion!==8||readback.marker?.mode!=='r2'||readback.marker.programmeRunId!==null||readback.marker.generation!==0||readback.marker.watchlistGeneration!==0)throw new OperatorStop('readback_mismatch',3);
 return {operation:'apply', writes:true, writeState:'committed', bookmark:ctx.bookmark, writers, schemaVersion:readback.schemaVersion, mode:readback.marker.mode, generation:readback.marker.generation, programmeRunId:readback.marker.programmeRunId};
}

async function readPublished(client){
 const pointer=await readObject(client,'epg/published-generation.json');
 const programme=await readObject(client,'programme.json');
 const watchlist=await readObject(client,'watchlist.json');
 const pointerBody=parseRecord(pointer.text,'epg/published-generation.json');
 const programmeBody=parseRecord(programme.text,'programme.json');
 const watchlistBody=parseRecord(watchlist.text,'watchlist.json');
 if(pointerBody.phase!=='published'||typeof pointerBody.programmeRunId!=='string'||!pointerBody.programmeRunId)throw new OperatorStop('source_invalid',3);
 if(programmeBody.runId!==pointerBody.programmeRunId)throw new OperatorStop('source_invalid',3);
 return {pointer, programme, watchlist, pointerBody, programmeBody, watchlistBody};
}

async function loadPublished(binding, source, ctx){
 const imported=await importPublished(binding,{confirm:'load',programme:source.programmeBody,watchlist:source.watchlistBody,programmeRunId:source.pointerBody.programmeRunId,publishedAt:source.programmeBody.updatedAt??null,pointerEtag:source.pointer.etag,watchlistEtag:source.watchlist.etag});
 const readback=await readSnapshot(binding);
 if(readback.marker?.mode!=='r2'||readback.marker.programmeRunId!==source.pointerBody.programmeRunId||readback.marker.mirrorEtag!==source.pointer.etag)throw new OperatorStop('readback_mismatch',3);
 return {operation:'load', writes:true, writeState:'committed', bookmark:ctx.bookmark, mode:'r2', programmeRunId:imported.programmeRunId, generation:imported.generation, mirrorEtag:imported.mirrorEtag};
}

async function activateMarker(binding, source, ctx, snapshot){
 const after=await activatePublished(binding,{confirm:'activate',pointerEtag:source.pointer.etag});
 const readback=await readSnapshot(binding);
 if(after.mode!=='d1'||readback.marker?.mode!=='d1'||readback.marker.programmeRunId!==snapshot.marker.programmeRunId)throw new OperatorStop('readback_mismatch',3);
 return {operation:'activate', writes:true, writeState:'committed', bookmark:ctx.bookmark, mode:'d1', programmeRunId:readback.marker.programmeRunId, generation:readback.marker.generation};
}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 runPublishedEpgProduction().then(({exit, result})=>{
  process.stdout.write(JSON.stringify(result)+'\n');
  if(exit===2)process.stderr.write('refuse: '+result.reason+'\n');
  else if(exit===3)process.stderr.write('no-go: '+result.reason+(result.writeState==='unknown'?'; read back, do not retry':result.writeState==='committed'?'; the write returned, read back before another command':'')+'\n');
  else if(exit!==0)process.stderr.write('error: '+result.reason+'\n');
  process.exit(exit);
 }).catch(()=>{process.stderr.write('error: failed\n');process.exit(1);});
}
