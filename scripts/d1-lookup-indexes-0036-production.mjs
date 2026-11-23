#!/usr/bin/env node
// Owner-only operator of migration 0036 (two additive lookup indexes, AIR-579). DORMANT: merging it authorizes nothing. `--apply` is the single guarded production write the owner approved on the card
// (23 Nov 2026, D1 schema v35 -> v36) and nothing else: no other statement, no 0034/0035, no table, marker, authority, lease or flag. Modeled on the verified 0033/0034 operators.
//
//   --status   (default) strictly read-only: pinned target identity, the SHA-256 of the exact bytes of migrations/0036, schema_contract, the predecessor objects (13 aux tables, 3 receipt tables, 33 seal
//              triggers, the tables and indexes 0036 needs), whether the two new indexes exist, the authority rows and the three row-count baselines, the decision and its reason.
//   --apply    --target iptv --confirm apply --migration-sha256 <full SHA-256 from status>: ONE atomic D1 batch of the statements migrationStatements() extracts from the unchanged file (guard, two CREATE INDEX,
//              the schema_contract update = 4 statements), then an independent readback. Never split, never retried: an unclear answer is `write_uncertain` and the operator stops.
//
// Rollback (DROP INDEX) is NOT part of this operator and not of the owner's GO; dropping an index does not lower the schema version.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {AUX_TABLES} from '../src/prediction-aux-d1.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0036_epg_discovery_lookup_indexes.sql');
export const RECEIPT_TABLES=['prediction_aux_import_chunk','prediction_aux_seal','prediction_aux_verify_slice'];
export const SEAL_TRIGGERS=33;
export const NEW_INDEXES=['published_epg_show_discovery_by_match','film_external_id_by_scheme_value'];
export const PREDECESSOR_INDEXES=['published_epg_show_by_generation','film_external_id_one_trusted'];
export const NEEDED_TABLES=['published_epg_authority','published_epg_show','film_external_id','discovery_authority'];
export const EXPECTED_STATEMENTS=4;
const OPTIONS={'--target':'target','--confirm':'confirm','--migration-sha256':'migrationSha256'};
const sha256=value=>createHash('sha256').update(value).digest('hex');

export const migrationBytes=()=>fs.readFileSync(MIGRATION_PATH);
export const migrationSha256=()=>sha256(migrationBytes());
// The statements the Worker's REST batch gets: exactly those migrationStatements() extracts, checked for their shape (guard INSERT, two CREATE INDEX, the version UPDATE).
export function migrationSql(){
 const statements=migrationStatements(migrationBytes().toString('utf8'));
 const [guard,show,external,update]=statements;
 const shaped=statements.length===EXPECTED_STATEMENTS
  &&/^INSERT INTO schema_contract\b/i.test(guard||'')&&/^CREATE INDEX published_epg_show_discovery_by_match ON published_epg_show \(programme_run_id, match_reason\) WHERE basis = 'discovery'$/.test(show||'')
  &&/^CREATE INDEX film_external_id_by_scheme_value ON film_external_id \(scheme, value\)$/.test(external||'')&&/^UPDATE schema_contract\b[\s\S]*\bWHERE id = 1 AND version = 35$/i.test(update||'')
  &&!statements.some(sql=>/\b(COMMIT|DROP|ATTACH|DELETE|TRIGGER|ALTER)\b/i.test(sql));
 if(!shaped)throw new OperatorStop('migration_refused',3);
 return statements;
}

const rowsOf=async(binding,sql)=>(await binding.prepare(sql).bind().all()).results;
const num=value=>Number(value);
export async function readState(binding){
 try{
  const contract=(await rowsOf(binding,'SELECT id, version, note FROM schema_contract ORDER BY id, version')).map(row=>({id:num(row.id),version:num(row.version)}));
  const master=await rowsOf(binding,"SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger')");
  const names=type=>new Set(master.filter(row=>row.type===type).map(row=>row.name));
  const tables=names('table'),indexes=names('index'),triggers=[...names('trigger')];
  const state={
   contract,schemaVersion:contract.length===1&&contract[0].id===1?contract[0].version:null,
   auxTables:AUX_TABLES.filter(name=>tables.has(name)).length,receiptTables:RECEIPT_TABLES.filter(name=>tables.has(name)).length,
   sealTriggers:triggers.filter(name=>name.startsWith('prediction_aux_sealed_')).length,
   neededTables:NEEDED_TABLES.filter(name=>tables.has(name)).length,predecessorIndexes:PREDECESSOR_INDEXES.filter(name=>indexes.has(name)).length,
   newIndexes:NEW_INDEXES.filter(name=>indexes.has(name)),auxMarker:null,published:null,discovery:null,counts:null,
  };
  const one=async sql=>(await rowsOf(binding,sql))[0]??null;
  if(tables.has('prediction_aux_authority')){const row=await one('SELECT mode, generation FROM prediction_aux_authority WHERE id=1');state.auxMarker=row?{mode:row.mode,generation:num(row.generation)}:null;}
  if(tables.has('published_epg_authority')){const row=await one('SELECT mode, cutover, generation, programme_run_id AS programmeRunId, watchlist_generation AS watchlistGeneration FROM published_epg_authority WHERE id=1');state.published=row?{mode:row.mode,cutover:row.cutover??null,generation:num(row.generation),programmeRunId:row.programmeRunId??null,watchlistGeneration:num(row.watchlistGeneration)}:null;}
  if(tables.has('discovery_authority')){const row=await one('SELECT * FROM discovery_authority LIMIT 1');state.discovery=row?Object.fromEntries(Object.entries(row).filter(([key])=>/^(mode|cutover|generation|run|run_id|discovery_run_id)$/.test(key))):null;}
  if(tables.has('published_epg_show')&&tables.has('film_external_id')){
   const row=await one("SELECT (SELECT COUNT(*) FROM published_epg_show) AS shows, (SELECT COUNT(*) FROM published_epg_show WHERE basis='discovery') AS discoveryShows, (SELECT COUNT(*) FROM film_external_id) AS externalIds");
   state.counts={shows:num(row.shows),discoveryShows:num(row.discoveryShows),externalIds:num(row.externalIds)};
  }
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}
const predecessorComplete=state=>state.auxTables===AUX_TABLES.length&&state.receiptTables===RECEIPT_TABLES.length&&state.sealTriggers===SEAL_TRIGGERS&&state.neededTables===NEEDED_TABLES.length&&state.predecessorIndexes===PREDECESSOR_INDEXES.length;
export function applyDecision(state){
 if(state.schemaVersion===null)return 'schema_contract_unexpected';
 if(state.schemaVersion===36)return state.newIndexes.length===NEW_INDEXES.length?'already_applied':'partial_schema';
 if(state.schemaVersion!==35)return 'schema_unexpected';
 if(state.newIndexes.length)return 'partial_schema';
 if(!predecessorComplete(state))return 'predecessor_incomplete';
 if(state.auxMarker?.mode!=='r2'||state.auxMarker.generation!==0)return 'aux_marker_changed';
 if(!state.published||!state.counts)return 'state_unreadable';
 return 'apply';
}
export const view=state=>state?({schemaVersion:state.schemaVersion,schemaContractRows:state.contract.length,auxTables:state.auxTables+'/'+AUX_TABLES.length,receiptTables:state.receiptTables+'/'+RECEIPT_TABLES.length,sealTriggers:state.sealTriggers+'/'+SEAL_TRIGGERS,neededTables:state.neededTables+'/'+NEEDED_TABLES.length,predecessorIndexes:state.predecessorIndexes+'/'+PREDECESSOR_INDEXES.length,newIndexes:state.newIndexes,auxMarker:state.auxMarker,publishedAuthority:state.published,discoveryAuthority:state.discovery,counts:state.counts}):null;

// The readback of a committed apply: the version, the shape of both indexes (PRAGMA) and the plans of the real statements. Problems are named, never the data.
export async function readShape(binding){
 const problems=[];
 const info=async(index,table)=>{
  const list=(await rowsOf(binding,'PRAGMA index_list('+table+')')).find(row=>row.name===index);
  const columns=(await rowsOf(binding,'PRAGMA index_info('+index+')')).sort((a,b)=>num(a.seqno)-num(b.seqno)).map(row=>row.name);
  return {unique:list?num(list.unique):null,partial:list?num(list.partial):null,columns};
 };
 const show=await info('published_epg_show_discovery_by_match','published_epg_show'),external=await info('film_external_id_by_scheme_value','film_external_id');
 if(show.unique!==0||show.partial!==1||show.columns.join(',')!=='programme_run_id,match_reason')problems.push('show_index_shape');
 if(external.unique!==0||external.partial!==0||external.columns.join(',')!=='scheme,value')problems.push('external_index_shape');
 const master=(await rowsOf(binding,"SELECT sql FROM sqlite_master WHERE type='index' AND name='published_epg_show_discovery_by_match'"))[0];
 if(!/WHERE\s+basis\s*=\s*'discovery'/i.test(String(master?.sql||'')))problems.push('show_index_predicate');
 const plan=async sql=>(await rowsOf(binding,'EXPLAIN QUERY PLAN '+sql)).map(row=>String(row.detail)).join(' | ');
 const deletePlan=await plan("DELETE FROM published_epg_show WHERE programme_run_id=(SELECT programme_run_id FROM published_epg_authority WHERE id=1) AND basis='discovery' AND match_reason='x'");
 const lookupPlan=await plan("SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value='1'");
 if(!deletePlan.includes('published_epg_show_discovery_by_match'))problems.push('delete_plan');
 if(!lookupPlan.includes('film_external_id_by_scheme_value'))problems.push('lookup_plan');
 return {show,external,deletePlan,lookupPlan,problems};
}

async function write(binding,statements,ctx){
 ctx.track('unknown');
 try{await binding.batch(statements);}
 catch(error){
  // The binding itself refused (limits): nothing was sent.
  if(error instanceof OperatorStop){ctx.track('none');throw error;}
  let after=null;try{after=await readState(binding);}catch{after=null;}
  // Only a PROVEN statement rejection with the state read back unchanged (still v35, no new index) may end as "not applied". Everything else stays write_uncertain and is never retried.
  const clean=error instanceof D1Error&&error.kind==='statement'&&Boolean(after)&&after.schemaVersion===35&&after.newIndexes.length===0;
  ctx.track(clean?'none':'unknown');
  throw new OperatorStop(clean?'statement_failed':'write_uncertain',3,{state:view(after)});
 }
}

export async function execute(command,{binding,ctx={track:()=>{}},params={}}){
 const before=await readState(binding);
 const digest=migrationSha256();
 const decision=applyDecision(before);
 if(command==='status')return {operation:'status',writes:false,writeState:'none',migrationSha256:digest,statements:migrationSql().length,decision,...view(before)};
 if(params.migrationSha256!==digest)throw new OperatorStop('migration_sha256_mismatch',3);
 if(decision!=='apply')throw new OperatorStop(decision,3);
 await write(binding,migrationSql().map(sql=>binding.prepare(sql).bind()),ctx);
 let after,shape;
 try{after=await readState(binding);shape=await readShape(binding);}
 catch{ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}
 const problems=[...shape.problems];
 if(after.schemaVersion!==36)problems.push('schema_version');
 if(after.newIndexes.length!==NEW_INDEXES.length)problems.push('indexes_missing');
 if(JSON.stringify(after.counts)!==JSON.stringify(before.counts))problems.push('counts');
 for(const key of ['published','discovery','auxMarker'])if(JSON.stringify(after[key])!==JSON.stringify(before[key]))problems.push('changed:'+key);
 if(after.auxTables!==before.auxTables||after.receiptTables!==before.receiptTables||after.sealTriggers!==before.sealTriggers)problems.push('predecessor_changed');
 if(problems.length){ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,state:view(after)});}
 ctx.track('committed');
 return {operation:'apply',writes:true,writeState:'committed',migrationSha256:digest,statements:EXPECTED_STATEMENTS,before:view(before),after:view(after),indexes:{show:shape.show,external:shape.external,deletePlan:shape.deletePlan,lookupPlan:shape.lookupPlan}};
}

export function parseArgs(argv){
 const args=argv.slice(2);
 const commands=args.filter(arg=>arg==='--status'||arg==='--apply');
 if(commands.length>1)throw new OperatorStop('usage',2);
 const parsed={};
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  if(!OPTIONS[arg])throw new OperatorStop('usage',2);
  const next=args[index+1];
  if(next===undefined||next.startsWith('--')||parsed[OPTIONS[arg]]!==undefined)throw new OperatorStop('usage',2);
  parsed[OPTIONS[arg]]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='status'){if(parsed.confirm!==undefined||parsed.migrationSha256!==undefined)throw new OperatorStop('usage',2);return {command,params:{}};}
 if(parsed.confirm!=='apply')throw new OperatorStop('confirm',2);
 if(!/^[0-9a-f]{64}$/.test(parsed.migrationSha256||''))throw new OperatorStop('usage',2);
 return {command,params:{migrationSha256:parsed.migrationSha256}};
}

export async function runLookupIndexes0036Production({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,deps=null}={}){
 const ctx={writeState:'none',bookmark:null,track(state){ctx.writeState=state;}};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,target=null;
  if(deps)({binding}=deps);
  else{
   target=productionTarget(env);
   if(target.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
   // retries:0 — no request of this operator is ever repeated automatically (a write never is anyway).
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command==='apply')ctx.bookmark=await readBookmark(target,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,ctx,params:parsed.params});
  let after=null;
  if(parsed.command==='apply'&&target)try{after=await readBookmark(target,fetchImpl);}catch{after=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(after?{bookmarkAfter:after}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runLookupIndexes0036Production();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
