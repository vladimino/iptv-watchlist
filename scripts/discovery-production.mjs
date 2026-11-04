#!/usr/bin/env node
// Production entry for the discovery schema (ADR 0085). Default is read-only.
// --target iptv reads the contract, the prerequisite tables, the four authority
// rows, the neighbour markers, the D1 bookmark and the idle state of sync, the
// resolver lease and the enrichment projection. It does not download a ledger.
// --apply --confirm apply --target iptv sends only migrations/0011_discovery_authority.sql,
// and only when the contract is a complete version 10 and every discovery table
// is absent. The inserted marker stays mode r2, cutover open, generation 0.
// --load --confirm load --target iptv copies the shared ledger into the
// observation tables. It runs only on version 11 with the marker still r2/open
// at generation 0, an idle transfer and no observations. The shared object and
// the published generation's copy must share a full etag and size. Mode stays
// r2. Generation becomes 1 only in the last batch. Catalog, decisions, scores,
// continuation, workflow, archive segments and the resolver lease are not
// copied. Hold, seal, activation, archive import and revert are not commands.
// A deploy does not run this script. Each write needs its own confirm. A
// write_uncertain result is not retried. This script does not call Time Travel
// restore. The D1 token is sent only to https://api.cloudflare.com/client/v4,
// and only for database iptv.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {evidenceKey} from '../src/discovery-authority.js';
import {createD1Adapter, D1Error, DEFAULT_ENDPOINT, renderSql} from './d1-backfill.mjs';
import {ExportError} from './migration-export.mjs';
import {createReadOnlyClient, readCredentials} from './r2-snapshot-export.mjs';

export const PRODUCTION_ACCOUNT_ID='8d9331889a693d328ef306692adf9d24';
export const PRODUCTION_DATABASE_ID='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb';
export const PRODUCTION_DATABASE_NAME='iptv';
export const PREREQUISITE=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent','published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row','owner_review_authority','owner_review_cas','owner_review_entry','ratings_domain_authority','ratings_domain_cas','ratings_document','ratings_view'];
export const DISCOVERY_TABLES=['discovery_authority','discovery_cas','discovery_transfer','discovery_lease','discovery_continuation','discovery_status','discovery_checkpoint','discovery_workflow','discovery_observation','discovery_observation_show','discovery_decision','discovery_decision_history','discovery_admission','discovery_segment','discovery_score','discovery_intent'];
const STATEMENT_BYTES=100*1024;
const BATCH_STATEMENTS=50;
const BATCH_BYTES=1024*1024;
const WRITER_WINDOW_MS=15*60*1000;
const SHOW_CAP=96;
export const LEDGER_MAX_BYTES=64*1024*1024;
const MIGRATION_PATH=path.join(path.dirname(fileURLToPath(import.meta.url)),'../migrations/0011_discovery_authority.sql');
const ALLOWED=/^(?:INSERT INTO schema_contract\b|UPDATE schema_contract\b|CREATE TABLE discovery_|CREATE INDEX discovery_|CREATE UNIQUE INDEX discovery_|CREATE TRIGGER\b|INSERT INTO discovery_)/i;

export class OperatorStop extends Error{
 constructor(reason, exitCode=3, detail){
  super(reason);
  this.reason=reason;
  this.exitCode=exitCode;
  this.detail=detail;
 }
}

export function migrationStatements(sql){
 const source=String(sql).split('\n').filter(line=>!/^\s*--/.test(line)).join('\n');
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
   const opens=(current.match(/\bBEGIN\b/gi)||[]).length;
   const closes=(current.match(/\bEND\b/gi)||[]).length;
   if(opens>closes){current+=character;continue;}
   const text=current.trim();
   if(text)statements.push(text);
   current='';
   continue;
  }
  current+=character;
 }
 const tail=current.trim();
 if(tail)statements.push(tail);
 return statements;
}

export function discoveryStatements(){
 const statements=migrationStatements(fs.readFileSync(MIGRATION_PATH,'utf8'));
 const refused=statements.some(sql=>!ALLOWED.test(sql.trim())||/\bCOMMIT\b|\bINTO\s+film\b|\bINTO\s+candidate\b|\bINTO\s+ratings_|\bINTO\s+prediction_|\bINTO\s+owner_review_|\bINTO\s+published_epg_|\bwatchlist_film\b/i.test(sql)||(/\bBEGIN\b/i.test(sql)&&!/^CREATE TRIGGER\b/i.test(sql.trim())));
 if(statements.length!==29||refused)throw new OperatorStop('migration_refused',3);
 return statements;
}

export function applyDecision(snapshot){
 const present=DISCOVERY_TABLES.filter(name=>snapshot.discovery?.[name]);
 if(present.length&&present.length!==DISCOVERY_TABLES.length)return 'partial_schema';
 if(present.length===DISCOVERY_TABLES.length){
  const marker=snapshot.marker;
  if(Number(snapshot.schemaVersion)!==11||!marker||marker.mode!=='r2'||marker.cutover!=='open')return 'partial_schema';
  if(marker.generation===0&&marker.programmeRunId==null)return 'already_applied';
  if(marker.generation>=1&&marker.programmeRunId)return 'loaded';
  return 'partial_schema';
 }
 if(Number(snapshot.schemaVersion)!==10)return 'schema_unexpected';
 if(!snapshot.prerequisite||!snapshot.authorities)return 'prerequisite_incomplete';
 return 'apply';
}

export function loadDecision(snapshot){
 if(Number(snapshot.schemaVersion)!==11)return 'schema_unexpected';
 const present=DISCOVERY_TABLES.filter(name=>snapshot.discovery?.[name]);
 if(present.length!==DISCOVERY_TABLES.length)return 'prerequisite_incomplete';
 const marker=snapshot.marker;
 if(!marker||marker.mode!=='r2'||marker.cutover!=='open')return 'marker_refused';
 const observations=Number(snapshot.observations);
 if(!Number.isFinite(observations))return 'partial_load';
 const state=snapshot.transfer?.state??null;
 const programme=marker.programmeRunId;
 const published=marker.publishedProgrammeRunId===programme&&snapshot.transfer?.programmeRunId===programme;
 if(marker.generation===0&&programme==null&&marker.publishedProgrammeRunId==null&&state==='idle'&&observations===0)return 'load';
 if(marker.generation>=1&&programme&&published&&state==='committed')return 'already_loaded';
 return 'partial_load';
}

function storedInteger(value){
 if(value==null||value==='')return null;
 const number=Number(value);
 if(!Number.isFinite(number)||!Number.isInteger(number))throw new OperatorStop('ledger_refused',3);
 return number;
}

function showsOf(item){
 const shows=Array.isArray(item?.shows)?item.shows:[];
 if(shows.length>SHOW_CAP)throw new OperatorStop('ledger_refused',3);
 return shows.map(show=>({channelId:show?.channelId??null,channel:show?.channel??null,start:storedInteger(show?.start),end:storedInteger(show?.end)}));
}

export function ledgerStatements(document){
 if(!document||typeof document!=='object'||Array.isArray(document)||!Array.isArray(document.items))throw new OperatorStop('ledger_refused',3);
 const run=document.programmeRunId;
 if(typeof run!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(run))throw new OperatorStop('ledger_refused',3);
 const seen=new Set();
 const statements=[];
 let shows=0;
 for(const item of document.items){
  if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.key!=='string'||!item.key||item.key.length>200||/[\u0000-\u001f]/.test(item.key)||seen.has(item.key))throw new OperatorStop('ledger_refused',3);
  seen.add(item.key);
  const rows=showsOf(item);
  const payload={...item};
  delete payload.shows;
  statements.push(renderSql("INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES ('active',?,'active',?,?,?,?,?,?,?,?,?,?)",[item.key,run,item.normalizedTitle??null,item.title??null,Number.isInteger(item.year)?item.year:null,evidenceKey(item),item.seenInLatestSnapshot===true?1:item.seenInLatestSnapshot===false?0:null,item.lastSeenAt??null,storedInteger(item.lastAiring),item.confirmedTmdbId==null?null:String(item.confirmedTmdbId),JSON.stringify(payload)]));
  rows.forEach((show,ordinal)=>{
   shows++;
   statements.push(renderSql("INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES ('active',?,?,?,?,?,?)",[item.key,ordinal,show.channelId,show.channel,show.start,show.end]));
  });
 }
 for(const sql of statements)if(Buffer.byteLength(sql,'utf8')>STATEMENT_BYTES)throw new OperatorStop('batch_too_large',3);
 return {run,items:document.items.length,shows,statements};
}

function fits(list, extra){
 const bytes=list.concat(extra).reduce((sum,sql)=>sum+Buffer.byteLength(sql,'utf8'),0);
 return list.length+extra.length<=BATCH_STATEMENTS&&bytes<=BATCH_BYTES;
}

function openingSql(){
 return [
  "UPDATE discovery_transfer SET state='loading', batches=0 WHERE id=1 AND state='idle' AND programme_run_id IS NULL",
  "INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state='loading' AND programme_run_id IS NULL)",
 ];
}

function closingSql(run, batches){
 return [
  renderSql("UPDATE discovery_authority SET programme_run_id=?, published_programme_run_id=?, generation=generation+1 WHERE id=1 AND mode='r2' AND cutover='open' AND generation=0 AND programme_run_id IS NULL AND published_programme_run_id IS NULL",[run,run]),
  renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_authority WHERE id=1 AND mode='r2' AND cutover='open' AND generation=1 AND programme_run_id=? AND published_programme_run_id=?)",[run,run]),
  renderSql("UPDATE discovery_transfer SET state='committed', programme_run_id=?, batches=? WHERE id=1 AND state='loading' AND programme_run_id IS NULL",[run,batches]),
  renderSql("INSERT INTO discovery_cas (id, ok) SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state='committed' AND programme_run_id=?)",[run]),
 ];
}

export function packLedgerBatches(statements, run){
 const chunks=[];
 let current=[];
 for(const sql of statements){
  if(current.length&&!fits(current,[sql])){chunks.push(current);current=[];}
  if(!fits(current,[sql]))throw new OperatorStop('batch_too_large',3);
  current.push(sql);
 }
 chunks.push(current);
 const opening=openingSql();
 if(!fits(chunks[0],opening))chunks.unshift([]);
 chunks[0]=opening.concat(chunks[0]);
 let count=chunks.length;
 let closing=closingSql(run,count);
 const last=chunks[chunks.length-1];
 if(!fits(last,closing)){
  count+=1;
  closing=closingSql(run,count);
  chunks.push(closing);
 }else chunks[chunks.length-1]=last.concat(closing);
 for(const chunk of chunks)if(!fits(chunk,[]))throw new OperatorStop('batch_too_large',3);
 return chunks;
}

function prefix(value){
 return typeof value==='string'&&value?value.slice(0,12):null;
}

function parseArgs(argv){
 const args=argv.slice(2);
 const commands=['--apply','--load','--activate','--import','--revert'].filter(flag=>args.includes(flag));
 if(commands.length>1)throw new OperatorStop('usage',2);
 const command=commands[0]||'status';
 if(command!=='status'&&command!=='--apply'&&command!=='--load')throw new OperatorStop('usage',2);
 const target=args.includes('--target')?args[args.indexOf('--target')+1]:undefined;
 const confirm=args.includes('--confirm')?args[args.indexOf('--confirm')+1]:undefined;
 if((args.includes('--target')&&!target)||(args.includes('--confirm')&&!confirm))throw new OperatorStop('usage',2);
 const known=new Set(['--apply','--load','--target','--confirm']);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(!known.has(arg))throw new OperatorStop('usage',2);
  if(arg==='--target'||arg==='--confirm')index++;
 }
 if(target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {command:'status',local:true};
 }
 if(target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_refused',2);
 if(command==='--apply'&&confirm!=='apply')throw new OperatorStop('confirm_required',2);
 if(command==='--load'&&confirm!=='load')throw new OperatorStop('confirm_required',2);
 if(command==='status'&&confirm!==undefined)throw new OperatorStop('usage',2);
 return {command,target,confirm};
}

function productionTarget(env){
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim();
 const apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 const configuredId=String(env.D1_BACKFILL_DATABASE_ID||'').trim();
 if(!/^[0-9a-f]{32}$/.test(accountId)||!apiToken)throw new OperatorStop('credentials_missing',2);
 if(accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(configuredId&&configuredId!==PRODUCTION_DATABASE_ID)throw new OperatorStop('database_identity',3);
 const endpoint=String(env.D1_BACKFILL_ENDPOINT||'').trim();
 if(endpoint){
  let url;
  try{url=new URL(endpoint);}catch{throw new OperatorStop('endpoint_refused',3);}
  const normalized=url.origin+url.pathname.replace(/\/$/,'');
  if(url.username||url.password||url.search||url.hash||normalized!==DEFAULT_ENDPOINT)throw new OperatorStop('endpoint_refused',3);
 }
 return {accountId,apiToken,endpoint:DEFAULT_ENDPOINT,maxBatchStatements:BATCH_STATEMENTS,maxBatchBytes:BATCH_BYTES};
}

function createBinding(adapter, reads){
 return {
  prepare(sql){
   return {bind(...params){
    if(params.length>20)throw new OperatorStop('batch_too_large',3);
    const text=renderSql(sql,params);
    if(Buffer.byteLength(text,'utf8')>STATEMENT_BYTES)throw new OperatorStop('batch_too_large',3);
    const inspected=async()=>{
     const report=await adapter.inspect(sql,params);
     reads.rowsWritten+=report.rowsWritten;
     reads.rowsRead+=Number.isFinite(report.rowsRead)?report.rowsRead:0;
     if(report.bookmark)reads.sqlBookmark=report.bookmark;
     return report.rows;
    };
    return {
     text,
     async first(){return (await inspected())[0]??null;},
     async all(){return {results:await inspected()};},
    };
   }};
  },
 };
}

async function snapshotOf(binding){
 const versionRow=await binding.prepare('SELECT version FROM schema_contract WHERE id=1').bind().first();
 const names=(await binding.prepare("SELECT name FROM sqlite_master WHERE type='table'").bind().all()).results.map(row=>row.name);
 const discovery=Object.fromEntries(DISCOVERY_TABLES.map(name=>[name,names.includes(name)]));
 const prerequisite=PREREQUISITE.every(name=>names.includes(name));
 const markers={};
 if(names.includes('ratings_domain_authority')){
  const row=await binding.prepare('SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1').bind().first();
  markers.ratings=row?{mode:row.mode,cutover:row.cutover,generation:Number(row.generation)}:null;
 }
 if(names.includes('published_epg_authority')){
  const row=await binding.prepare('SELECT mode, cutover, generation, programme_run_id AS programmeRunId, watchlist_generation AS watchlistGeneration FROM published_epg_authority WHERE id=1').bind().first();
  markers.publishedEpg=row?{mode:row.mode,cutover:row.cutover,generation:Number(row.generation),watchlistGeneration:Number(row.watchlist_generation??row.watchlistGeneration),programmeRunId:row.programmeRunId??null}:null;
 }
 if(names.includes('owner_review_authority')){
  const row=await binding.prepare('SELECT mode, writes, generation FROM owner_review_authority WHERE id=1').bind().first();
  markers.ownerReviews=row?{mode:row.mode,writes:row.writes,generation:Number(row.generation)}:null;
 }
 if(names.includes('prediction_domain_authority')){
  const row=await binding.prepare('SELECT mode, writes, generation, queue_generation AS queueGeneration, profile_generation AS profileGeneration FROM prediction_domain_authority WHERE id=1').bind().first();
  markers.predictions=row?{mode:row.mode,writes:row.writes,generation:Number(row.generation),queueGeneration:Number(row.queueGeneration),profileGeneration:Number(row.profileGeneration)}:null;
 }
 if(names.includes('metadata_cache_authority')){
  const row=await binding.prepare('SELECT mode, cache_generation AS cacheGeneration FROM metadata_cache_authority WHERE id=1').bind().first();
  markers.metadataCache=row?{mode:row.mode,generation:Number(row.cacheGeneration)}:null;
 }
 let marker=null;
 if(discovery.discovery_authority){
  const row=await binding.prepare('SELECT mode, cutover, generation, programme_run_id AS programmeRunId, published_programme_run_id AS publishedProgrammeRunId FROM discovery_authority WHERE id=1').bind().first();
  if(row)marker={mode:row.mode,cutover:row.cutover,generation:Number(row.generation),programmeRunId:row.programmeRunId??null,publishedProgrammeRunId:row.publishedProgrammeRunId??null};
 }
 let transfer=null;
 if(discovery.discovery_transfer){
  const row=await binding.prepare('SELECT state, programme_run_id AS programmeRunId FROM discovery_transfer WHERE id=1').bind().first();
  transfer=row?{state:row.state,programmeRunId:row.programmeRunId??null}:null;
 }
 let observations=null;
 if(discovery.discovery_observation){
  const row=await binding.prepare('SELECT COUNT(*) AS n FROM discovery_observation').bind().first();
  observations=Number(row?.n);
  if(!Number.isFinite(observations))throw new OperatorStop('unknown_state',3);
 }
 const authorityRows=await Promise.all([
  names.includes('prediction_domain_authority')?binding.prepare('SELECT id FROM prediction_domain_authority WHERE id=1').bind().first():null,
  names.includes('published_epg_authority')?binding.prepare('SELECT id FROM published_epg_authority WHERE id=1').bind().first():null,
  names.includes('owner_review_authority')?binding.prepare('SELECT id FROM owner_review_authority WHERE id=1').bind().first():null,
  names.includes('ratings_domain_authority')?binding.prepare('SELECT id FROM ratings_domain_authority WHERE id=1').bind().first():null,
 ]);
 return {schemaVersion:Number(versionRow?.version),discovery,prerequisite,authorities:authorityRows.every(row=>row?.id===1||row?.id==='1'),marker,markers,transfer,observations};
}

function r2Credentials(env){
 const accountId=String(env.R2_SNAPSHOT_ACCOUNT_ID||'').trim();
 const accessKeyId=String(env.R2_SNAPSHOT_ACCESS_KEY_ID||'').trim();
 const secretAccessKey=String(env.R2_SNAPSHOT_SECRET_ACCESS_KEY||'').trim();
 if(!accountId&&!accessKeyId&&!secretAccessKey)return null;
 const credentials=readCredentials(env);
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID||credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 if(credentials.endpointOverride)throw new OperatorStop('endpoint_refused',3);
 return credentials;
}

async function headObject(client, key){
 const head=await client.head(key);
 if(!head)return {present:false};
 const again=await client.head(key,{ifMatch:head.etag});
 if(!again||again.etag!==head.etag||again.size!==head.size)throw new OperatorStop('source_changed',3);
 return {present:true,bytes:head.size,etagPrefix:prefix(head.etag)};
}

async function readJson(client, key){
 const head=await client.head(key);
 if(!head)return null;
 if(head.size>200000)throw new OperatorStop('source_changed',3);
 const got=await client.get(key,{ifMatch:head.etag});
 if(!got)throw new OperatorStop('source_changed',3);
 const text=Buffer.from(await new Response(got.body).arrayBuffer()).toString('utf8');
 const again=await client.head(key,{ifMatch:head.etag});
 if(!again||again.etag!==head.etag)throw new OperatorStop('source_changed',3);
 return JSON.parse(text);
}

async function writerReport(client, binding, now){
 const sync=await readJson(client,'sync.json');
 const lease=await readJson(client,'epg/resolver-lease.json');
 let syncState='absent';
 if(sync){
  if(['metadata','epg'].includes(sync.stage)){
   const updated=Date.parse(sync.updatedAt);
   syncState=!Number.isFinite(updated)||now-updated<WRITER_WINDOW_MS?'active':'idle';
  }else syncState='idle';
 }
 const resolverState=lease?(Number(lease.expiresAt)>now?'active':'idle'):'absent';
 const row=await binding.prepare('SELECT lease_until AS leaseUntil FROM projection_run WHERE projection=?').bind('enrichment').first();
 const projectionState=row?.leaseUntil&&Date.parse(row.leaseUntil)>now?'active':'idle';
 return {sync:syncState,resolver:resolverState,projection:projectionState};
}

async function sourceReport(client, programmeRunId){
 const shared=await headObject(client,'epg/discovery-latest.json');
 let generation=null;
 if(typeof programmeRunId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(programmeRunId))generation=await headObject(client,'epg/generations/'+programmeRunId+'/discovery-latest.json');
 return {shared,generation,stable:true};
}

async function readLedger(client, programmeRunId){
 if(typeof programmeRunId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(programmeRunId))throw new OperatorStop('source_missing',3);
 const sharedKey='epg/discovery-latest.json';
 const generationKey='epg/generations/'+programmeRunId+'/discovery-latest.json';
 const shared=await client.head(sharedKey);
 const generation=await client.head(generationKey);
 if(!shared||!generation)throw new OperatorStop('source_missing',3);
 if(shared.etag!==generation.etag||shared.size!==generation.size)throw new OperatorStop('source_mismatch',3);
 if(shared.size>LEDGER_MAX_BYTES)throw new OperatorStop('ledger_too_large',3);
 const got=await client.get(sharedKey,{ifMatch:shared.etag});
 if(!got)throw new OperatorStop('source_changed',3);
 const body=Buffer.from(await new Response(got.body).arrayBuffer());
 if(body.length!==shared.size)throw new OperatorStop('source_changed',3);
 const againShared=await client.head(sharedKey,{ifMatch:shared.etag});
 const againGeneration=await client.head(generationKey,{ifMatch:generation.etag});
 if(!againShared||!againGeneration||againShared.etag!==shared.etag||againGeneration.etag!==generation.etag||againShared.size!==shared.size||againGeneration.size!==generation.size)throw new OperatorStop('source_changed',3);
 let document;
 try{document=JSON.parse(body.toString('utf8'));}
 catch{throw new OperatorStop('ledger_refused',3);}
 if(!document||document.programmeRunId!==programmeRunId)throw new OperatorStop('ledger_refused',3);
 return {document,bytes:shared.size,etag:shared.etag};
}

function neighboursMoved(before, after){
 return !sameMarker(before.ratings,after.ratings)||!sameMarker(before.publishedEpg,after.publishedEpg)||!sameMarker(before.ownerReviews,after.ownerReviews)||!sameMarker(before.predictions,after.predictions)||!sameMarker(before.metadataCache,after.metadataCache);
}

async function readBookmark(target, fetchImpl){
 const url=target.endpoint+'/accounts/'+target.accountId+'/d1/database/'+PRODUCTION_DATABASE_ID+'/time_travel/bookmark';
 let response;
 try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:'Bearer '+target.apiToken},redirect:'error'});}
 catch{throw new OperatorStop('bookmark_unavailable',3);}
 if(response.status===401||response.status===403){await response.body?.cancel();throw new OperatorStop('authorization',3);}
 let payload=null;
 try{payload=await response.json();}catch{payload=null;}
 const bookmark=payload?.result?.bookmark??payload?.bookmark??null;
 if(!response.ok||typeof bookmark!=='string'||!bookmark)throw new OperatorStop('bookmark_unavailable',3);
 return bookmark;
}

function sameMarker(left, right){
 return JSON.stringify(left??null)===JSON.stringify(right??null);
}

function normalize(error){
 if(error instanceof OperatorStop)return error;
 if(error instanceof D1Error)return new OperatorStop(error.kind==='write_uncertain'?'write_uncertain':'d1_'+error.kind,error.kind==='write_uncertain'?4:3);
 if(error instanceof ExportError)return new OperatorStop('source_'+error.kind,3);
 return new OperatorStop('unknown_state',3);
}

export async function runDiscoveryProduction({argv=process.argv,env=process.env,fetchImpl=fetch,now=Date.now()}={}){
 const args=parseArgs(argv);
 if(args.local)return {exit:0,result:{configured:false,writes:false,writeState:'none'}};
 const reads={rowsWritten:0,rowsRead:0,sqlBookmark:null};
 let writeState='none';
 try{
  const target=productionTarget(env);
  const adapter=createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl});
  const described=await adapter.describe();
  if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('database_identity',3);
  const binding=createBinding(adapter,reads);
  const snapshot=await snapshotOf(binding);
  const bookmark=await readBookmark(target,fetchImpl);
  const credentials=r2Credentials(env);
  const client=credentials?createReadOnlyClient({credentials,fetchImpl}):null;
  let writers=null, source=null;
  if(client){
   writers=await writerReport(client,binding,typeof now==='function'?now():now);
   source=await sourceReport(client,snapshot.markers.publishedEpg?.programmeRunId??null);
  }
  const decision=applyDecision(snapshot);
  const report={
   operation:'status',
   writes:false,
   writeState,
   rowsWritten:reads.rowsWritten,
   bookmarkPrefix:prefix(bookmark),
   sqlBookmarkPrefix:prefix(reads.sqlBookmark),
   schemaVersion:snapshot.schemaVersion,
   prerequisiteTables:snapshot.prerequisite?PREREQUISITE.length:0,
   authorityRows:snapshot.authorities?4:0,
   discoveryTables:DISCOVERY_TABLES.filter(name=>snapshot.discovery[name]).length,
   decision,
   load:loadDecision(snapshot),
   marker:snapshot.marker,
   markers:snapshot.markers,
   transfer:snapshot.transfer?.state??null,
   observations:snapshot.observations,
   writers,
   source,
   r2:client?'configured':'not_configured',
  };
  if(args.command==='status')return {exit:0,result:report};
  if(!client)throw new OperatorStop('source_missing',3);
  if(Object.values(writers).includes('active'))throw new OperatorStop('writer_active',3);
  if(args.command==='--apply'){
   if(decision!=='apply')throw new OperatorStop(decision,3);
   const before=snapshot.markers;
   writeState='unknown';
   await adapter.executeRendered(discoveryStatements());
   writeState='committed';
   const readback=await snapshotOf(binding);
   const transfer=await binding.prepare("SELECT state FROM discovery_transfer WHERE id=1").bind().first();
   const observations=await binding.prepare("SELECT COUNT(*) AS n FROM discovery_observation").bind().first();
   const marker=readback.marker;
   if(readback.schemaVersion!==11||marker?.mode!=='r2'||marker.cutover!=='open'||marker.generation!==0||marker.programmeRunId!=null)throw new OperatorStop('readback_mismatch',4);
   if(transfer?.state!=='idle'||Number(observations?.n)!==0)throw new OperatorStop('readback_mismatch',4);
   if(neighboursMoved(before,readback.markers))throw new OperatorStop('readback_mismatch',4);
   return {exit:0,result:{operation:'apply',writes:true,writeState,rowsWritten:reads.rowsWritten,bookmarkPrefix:prefix(bookmark),schemaVersion:11,mode:'r2',cutover:'open',generation:0,discoveryTables:DISCOVERY_TABLES.length,observations:0}};
  }
  const gate=loadDecision(snapshot);
  if(!client)throw new OperatorStop('source_missing',3);
  if(Object.values(writers).includes('active'))throw new OperatorStop('writer_active',3);
  if(gate!=='load')throw new OperatorStop(gate,3);
  const ledger=await readLedger(client,snapshot.markers.publishedEpg?.programmeRunId??null);
  const built=ledgerStatements(ledger.document);
  if(built.run!==snapshot.markers.publishedEpg?.programmeRunId)throw new OperatorStop('ledger_refused',3);
  const batches=packLedgerBatches(built.statements,built.run);
  const freshWriters=await writerReport(client,binding,typeof now==='function'?now():now);
  if(Object.values(freshWriters).includes('active'))throw new OperatorStop('writer_active',3);
  const fresh=await snapshotOf(binding);
  const freshGate=loadDecision(fresh);
  if(freshGate!=='load')throw new OperatorStop(freshGate,3);
  if(neighboursMoved(snapshot.markers,fresh.markers))throw new OperatorStop('source_changed',3);
  const beforeLoad=fresh.markers;
  writeState='unknown';
  for(const batch of batches)await adapter.executeRendered(batch);
  const loaded=await snapshotOf(binding);
  const showCount=await binding.prepare('SELECT COUNT(*) AS n FROM discovery_observation_show').bind().first();
  const other=await binding.prepare("SELECT (SELECT COUNT(*) FROM discovery_observation WHERE residence<>'active' OR source_key<>'active') AS residence, (SELECT COUNT(*) FROM discovery_decision) AS decisions, (SELECT COUNT(*) FROM discovery_admission) AS admissions, (SELECT COUNT(*) FROM discovery_segment) AS segments, (SELECT COUNT(*) FROM discovery_score) AS scores, (SELECT COUNT(*) FROM discovery_intent) AS intents").bind().first();
  const lease=await binding.prepare('SELECT lease_id AS leaseId, expires_at AS expiresAt FROM discovery_lease WHERE id=1').bind().first();
  const marker=loaded.marker;
  const transfer=loaded.transfer;
  if(loaded.schemaVersion!==11||marker?.mode!=='r2'||marker.cutover!=='open'||marker.generation!==1||marker.programmeRunId!==built.run||marker.publishedProgrammeRunId!==built.run)throw new OperatorStop('readback_mismatch',4);
  if(transfer?.state!=='committed'||transfer.programmeRunId!==built.run||loaded.observations!==built.items||Number(showCount?.n)!==built.shows)throw new OperatorStop('readback_mismatch',4);
  if(Number(other?.residence)!==0||Number(other?.decisions)!==0||Number(other?.admissions)!==0||Number(other?.segments)!==0||Number(other?.scores)!==0||Number(other?.intents)!==0)throw new OperatorStop('readback_mismatch',4);
  if(lease?.leaseId!=null||Number(lease?.expiresAt)!==0)throw new OperatorStop('readback_mismatch',4);
  if(neighboursMoved(beforeLoad,loaded.markers))throw new OperatorStop('readback_mismatch',4);
  writeState='committed';
  return {exit:0,result:{operation:'load',writes:true,writeState,rowsWritten:reads.rowsWritten,bookmarkPrefix:prefix(bookmark),schemaVersion:11,mode:'r2',cutover:'open',generation:1,programmeRunId:built.run,observations:built.items,shows:built.shows,batches:batches.length,etagCompared:true,etagPrefix:prefix(ledger.etag),bytes:ledger.bytes,decisions:0,admissions:0}};
 }catch(error){
  const stop=normalize(error);
  return {exit:stop.exitCode||1,result:{reason:stop.reason,writes:writeState==='committed'?true:writeState==='unknown'?null:false,writeState,rowsWritten:reads.rowsWritten}};
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runDiscoveryProduction().then(outcome=>{
  process.stdout.write(JSON.stringify(outcome.result)+'\n');
  process.exitCode=outcome.exit||0;
 }).catch(error=>{
  const stop=error instanceof OperatorStop?error:normalize(error);
  process.stdout.write(JSON.stringify({reason:stop.reason})+'\n');
  process.exitCode=stop.exitCode||1;
 });
}
