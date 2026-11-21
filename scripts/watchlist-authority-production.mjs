#!/usr/bin/env node
// Narrow production operator for ONE step: the schema-only apply of migrations/0031_watchlist_authority.sql (ADR 0186, AIR-571 owner GO of 21 Nov 2026).
// Modeled on the atomic 0030 apply (scripts/epg-checkpoint-production.mjs `apply`). It is NOT the general A-E operator and has no other command:
// no 0032/0033, no import, no marker switch, no R2, no flag, no Task. Default is read-only `status`.
//
//   status   read-only: target, schema version, 0031 objects present/absent, the Watchlist marker, the other domain markers
//   apply    exactly v30 + valid epg_checkpoint tables + no 0031 object + no executing EPG step -> ONE atomic D1 batch of the whole file,
//            then an independent read-only readback. Nothing is retried; an uncertain outcome is read back and reported as write_uncertain.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter} from './d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {applyBusy} from './epg-checkpoint-production.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0031_watchlist_authority.sql');
export const COMMANDS=['status','apply'];
const EPG_CHECKPOINT=['epg_checkpoint_authority','epg_checkpoint_cas','epg_checkpoint_run'];
// Other domains' markers: read before and after, and required to be byte-identical.
const OTHER_MARKERS=['epg_checkpoint_authority','published_epg_authority','ratings_domain_authority','film_person_authority','discovery_authority','owner_review_authority','metadata_cache_authority','prediction_domain_authority'];
const WRITE_TABLES=['watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'];
const sha256=value=>createHash('sha256').update(value).digest('hex');

async function one(binding,sql){return (await binding.prepare(sql).bind().first())??null;}
async function many(binding,sql){return (await binding.prepare(sql).bind().all()).results||[];}
const json=text=>{try{return JSON.parse(text);}catch{return undefined;}};

export function migrationText(){return fs.readFileSync(MIGRATION_PATH,'utf8');}
export function migrationSha256(){return sha256(migrationText());}
export function migrationSql(){
 const statements=migrationStatements(migrationText());
 if(!statements.length||statements.some(sql=>/\bCOMMIT\b|\bDROP\s+TABLE\b|\bATTACH\b/i.test(sql)))throw new OperatorStop('migration_refused',3);
 return statements;
}
// The objects the file creates, taken from the file itself so that the readback can never drift from it.
export function expectedObjects(){
 const text=migrationStatements(migrationText()).join(';\n');
 const names=kind=>[...text.matchAll(new RegExp('CREATE\\s+'+kind+'\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([a-z_0-9]+)','gi'))].map(match=>match[1]);
 const triggers=names('TRIGGER'),tables=names('TABLE'),indexes=names('INDEX');
 return {tables,indexes,triggers:triggers.filter(name=>name!=='schema_contract_no_downgrade')};
}

export async function readState(binding){
 try{
  const wanted=expectedObjects();
  const version=Number((await one(binding,'SELECT version FROM schema_contract WHERE id=1'))?.version);
  const master=await many(binding,"SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger','index')");
  const has=(type,name)=>master.some(row=>row.type===type&&row.name===name);
  const present={
   tables:wanted.tables.filter(name=>has('table',name)),
   indexes:wanted.indexes.filter(name=>has('index',name)),
   triggers:wanted.triggers.filter(name=>has('trigger',name)),
  };
  const state={schemaVersion:Number.isFinite(version)?version:null,wanted,present,checkpoint:{tables:EPG_CHECKPOINT.filter(name=>has('table',name)).length,marker:null,cas:null,run:null},watchlist:null,counts:null,orchestration:{},markers:{}};
  if(state.checkpoint.tables===EPG_CHECKPOINT.length){
   state.checkpoint.marker=await one(binding,'SELECT mode, writes, generation FROM epg_checkpoint_authority WHERE id=1');
   state.checkpoint.cas=await one(binding,'SELECT ok FROM epg_checkpoint_cas WHERE id=1');
   state.checkpoint.run=await one(binding,'SELECT COUNT(*) AS n FROM epg_checkpoint_run');
  }
  if(has('table','watchlist_authority')&&has('table','watchlist_cas')&&has('table','watchlist_current')){
   state.watchlist={
    authority:await many(binding,'SELECT id, mode, generation, writes FROM watchlist_authority'),
    cas:await many(binding,'SELECT id, ok FROM watchlist_cas'),
    current:await many(binding,'SELECT id, version, snapshot_id, list_sha256, film_count, revision FROM watchlist_current'),
   };
   const counts={};
   for(const table of WRITE_TABLES)counts[table]=has('table',table)?Number((await one(binding,'SELECT COUNT(*) AS n FROM '+table))?.n):null;
   state.counts=counts;
  }
  if(has('table','epg_orchestration_document'))for(const row of await many(binding,'SELECT key, body, revision FROM epg_orchestration_document'))state.orchestration[row.key]={revision:Number(row.revision),body:json(row.body)??null};
  for(const table of OTHER_MARKERS)if(has('table',table))state.markers[table]=sha256(JSON.stringify(await many(binding,'SELECT * FROM '+table+' ORDER BY 1')));
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}

const nothingPresent=state=>!state.present.tables.length&&!state.present.indexes.length&&!state.present.triggers.length;
const everythingPresent=state=>state.present.tables.length===state.wanted.tables.length&&state.present.indexes.length===state.wanted.indexes.length&&state.present.triggers.length===state.wanted.triggers.length;
const checkpointValid=state=>state.checkpoint.tables===EPG_CHECKPOINT.length&&state.checkpoint.marker?.mode==='r2'&&state.checkpoint.marker?.writes==='open'&&Number(state.checkpoint.marker?.generation)===0&&Number(state.checkpoint.cas?.ok)===1&&state.checkpoint.run!==null;

// Decision of the apply: refuses anything but exactly "version 30, valid checkpoint authority, none of the 0031 objects".
export function applyDecision(state){
 if(!nothingPresent(state))return everythingPresent(state)&&state.schemaVersion===31?'already_applied':'partial_schema';
 if(state.schemaVersion!==30)return 'schema_unexpected';
 if(!checkpointValid(state))return 'checkpoint_invalid';
 return 'apply';
}

// What the independent readback must show after the apply.
export function readbackProblems(after,before){
 const problems=[];
 if(after.schemaVersion!==31)problems.push('schema_version');
 if(!everythingPresent(after))problems.push('objects_missing');
 const w=after.watchlist;
 if(!w||w.authority.length!==1||w.authority[0].id!==1||w.authority[0].mode!=='epg'||Number(w.authority[0].generation)!==0||w.authority[0].writes!=='open')problems.push('authority_row');
 if(!w||w.cas.length!==1||Number(w.cas[0].ok)!==1)problems.push('cas_row');
 const c=w?.current;
 if(!c||c.length!==1||Number(c[0].version)!==0||c[0].snapshot_id!==null||Number(c[0].revision)!==1)problems.push('current_row');
 if(!after.counts||WRITE_TABLES.some(table=>after.counts[table]!==0))problems.push('rows_written');
 for(const table of OTHER_MARKERS)if(before.markers[table]!==after.markers[table])problems.push('marker_changed:'+table);
 return problems;
}

const view=state=>({schemaVersion:state.schemaVersion,objects:{tables:state.present.tables.length+'/'+state.wanted.tables.length,indexes:state.present.indexes.length+'/'+state.wanted.indexes.length,triggers:state.present.triggers.length+'/'+state.wanted.triggers.length},checkpoint:{tables:state.checkpoint.tables,marker:state.checkpoint.marker,cas:state.checkpoint.cas?.ok??null},watchlist:state.watchlist,counts:state.counts});

export async function execute(command,{binding,now,ctx={}}){
 const clock=typeof now==='function'?now():now;
 const state=await readState(binding);
 if(command==='status')return {operation:'status',writes:false,writeState:'none',migrationSha256:migrationSha256(),decision:applyDecision(state),...view(state),epgBusy:applyBusy({orchestration:state.orchestration},clock)};
 if(command!=='apply')throw new OperatorStop('usage',2);
 const decision=applyDecision(state);
 if(decision!=='apply')throw new OperatorStop(decision,3);
 const busy=applyBusy({orchestration:state.orchestration},clock);
 if(busy)throw new OperatorStop('writer_active',3,{busy});
 const statements=migrationSql();
 if(ctx.track)ctx.track('unknown');
 try{await binding.batch(statements.map(sql=>binding.prepare(sql).bind()));}
 catch{
  // The batch is atomic and the file guards itself (exactly v30 with the checkpoint tables). Read the state before saying anything about the outcome; never retry.
  let after=null;
  try{after=await readState(binding);}catch{after=null;}
  const untouched=Boolean(after)&&after.schemaVersion===30&&nothingPresent(after);
  if(ctx.track)ctx.track(untouched?'none':'unknown');
  throw new OperatorStop(untouched?'statement_failed':'write_uncertain',3,{schemaVersion:after?.schemaVersion??null,objects:after?view(after).objects:null});
 }
 let after;
 try{after=await readState(binding);}catch{throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}
 const problems=readbackProblems(after,state);
 if(problems.length)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,...view(after)});
 if(ctx.track)ctx.track('committed');
 return {operation:'apply',writes:true,writeState:'committed',migrationSha256:migrationSha256(),statements:statements.length,before:view(state),after:view(after)};
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------
export function parseArgs(argv){
 const args=argv.slice(2);
 const commands=args.filter(arg=>arg.startsWith('--')&&COMMANDS.includes(arg.slice(2)));
 if(commands.length>1)throw new OperatorStop('usage',2);
 const parsed={};
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  if(arg!=='--target'&&arg!=='--confirm')throw new OperatorStop('usage',2);
  const next=args[index+1];
  if(next===undefined||next.startsWith('--')||parsed[arg.slice(2)]!==undefined)throw new OperatorStop('usage',2);
  parsed[arg.slice(2)]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='status'){if(parsed.confirm!==undefined)throw new OperatorStop('usage',2);}
 else if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 return {command};
}

export async function runWatchlistAuthorityProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,adapterTarget=null;
  if(deps)({binding}=deps);
  else{
   adapterTarget=productionTarget(env);
   const adapter=trackProductionWrites(createD1Adapter({target:adapterTarget,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command==='apply')ctx.bookmark=await readBookmark(adapterTarget,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,now,ctx:{track}});
  let after=null;
  if(parsed.command==='apply'&&adapterTarget)try{after=await readBookmark(adapterTarget,fetchImpl);}catch{after=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(after?{bookmarkAfter:after}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runWatchlistAuthorityProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
