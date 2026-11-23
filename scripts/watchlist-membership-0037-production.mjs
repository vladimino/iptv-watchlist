#!/usr/bin/env node
// Owner-only operator of migration 0037 (the Watchlist membership projection schema, ADR 0203, AIR-572). DORMANT: merging it authorizes nothing. Modeled on the verified 0036 operator.
//
//   --status            (default) strictly read-only: pinned target identity, the SHA-256 and Git blob of the exact bytes of migrations/0037, schema_contract, the 0036 indexes (0037 follows a COMPLETE v36),
//                       the tables 0037 needs, whether any 0037 object already exists, the Watchlist drain state (version, effects_drained_version, pending effects) and the authority rows, the decision and its reason.
//   --apply             --target iptv --confirm apply --migration-sha256 <full SHA-256 from status>: ONE atomic D1 batch of the 15 statements migrationStatements() extracts from the unchanged file, each checked
//                       against its expected shape, then an independent readback. Never split, never retried: an unclear answer is `write_uncertain` and the operator stops.
//   --baseline-dry-run  --target iptv: strictly read-only preflight of the ONE-TIME baseline reconciliation (ADR 0203 rollout step): the current Watchlist snapshot against `watchlist_film`, through the same
//                       trusted identity resolver the projection uses (src/watchlist-membership.js `membershipBaseline().dryRun`). Counts only (add / remove / keep / unresolved), never ids or titles.
//                       It does not need 0037 and writes nothing. The baseline APPLY and the marker SWITCH are NOT part of this operator: they write under the Letterboxd Sync epoch and need the Worker.
//
// The migration inserts the membership marker as mode `producer`, generation 0: after it the Worker behaves exactly as before (three effects per version, the EPG Producer owns membership; the Producer itself is
// held by PRODUCER_DELIVERY_HOLD). Rollback is NOT part of this operator: schema_contract never goes down and the rebuild of watchlist_effect is roll-forward only.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {membershipBaseline} from '../src/watchlist-membership.js';
import {readCurrentMembers} from '../src/watchlist-d1.js';
import {resolveSourceIdentitiesEach} from '../src/canonical-producer-workflow.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0037_watchlist_membership_projection.sql');
// The migration this operator may apply, pinned INDEPENDENTLY of the pin the caller passes: the exact bytes of migrations/0037 (Git blob on main ec41ad7, 23 Nov 2026, merged with ADR 0203 by PR #946).
export const APPROVED_SHA256='e9b2f61156477c60461eb239b3c1bd1f7fb83d534621ca8d62742dab9f7fb60e';
export const APPROVED_GIT_BLOB='277741025209209e9aceaac31e747197e21c4996';
export const EXPECTED_STATEMENTS=15;
export const PREDECESSOR_INDEXES=['published_epg_show_discovery_by_match','film_external_id_by_scheme_value'];
export const NEEDED_TABLES=['watchlist_authority','watchlist_current','watchlist_snapshot','watchlist_effect','watchlist_film','film_external_id'];
export const NEW_TABLES=['watchlist_membership_authority','watchlist_film_fence','watchlist_membership_handoff'];
export const NEW_TRIGGERS=['watchlist_membership_authority_required','watchlist_membership_authority_order','watchlist_film_fence_monotonic'];
export const NEW_INDEX='watchlist_membership_handoff_due';
export const EFFECT_TRIGGER='watchlist_effect_monotonic';
const SCRATCH_TABLE='watchlist_effect_v37';
const COMMANDS=['--status','--apply','--baseline-dry-run'];
const OPTIONS={'--target':'target','--confirm':'confirm','--migration-sha256':'migrationSha256'};
const sha256=value=>createHash('sha256').update(value).digest('hex');

export const migrationBytes=()=>fs.readFileSync(MIGRATION_PATH);
const gitBlob=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');
export const migrationSha256=(bytes=migrationBytes())=>sha256(bytes);
export const approved=(bytes=migrationBytes())=>sha256(bytes)===APPROVED_SHA256&&gitBlob(bytes)===APPROVED_GIT_BLOB;

// Each of the 15 statements must have exactly its expected shape, in order. DROP and ALTER appear ONLY as the rebuild of watchlist_effect (positions 10 and 11); nothing else may delete, attach or commit.
const SHAPES=[
 /^INSERT INTO schema_contract \(id, version, note\)\s+SELECT 1, 0, 'refused'[\s\S]*WHERE id = 1 AND version = 36\b[\s\S]*\) = 4\s*\)$/,
 /^CREATE TABLE watchlist_membership_authority \(/,
 /^CREATE TRIGGER watchlist_membership_authority_required\s+BEFORE DELETE ON watchlist_membership_authority\b/,
 /^CREATE TRIGGER watchlist_membership_authority_order\s+BEFORE UPDATE ON watchlist_membership_authority\b/,
 /^CREATE TABLE watchlist_film_fence \(/,
 /^CREATE TRIGGER watchlist_film_fence_monotonic\s+BEFORE UPDATE ON watchlist_film_fence\b/,
 /^CREATE TABLE watchlist_membership_handoff \(/,
 /^CREATE INDEX watchlist_membership_handoff_due ON watchlist_membership_handoff \(state, next_retry_at\)$/,
 /^CREATE TABLE watchlist_effect_v37 \([\s\S]*effect IN \('scan_facts', 'retention', 'removal_enqueue', 'membership'\)/,
 /^INSERT INTO watchlist_effect_v37 \(snapshot_id, effect, status, receipt, attempts, done_at\)\s+SELECT snapshot_id, effect, status, receipt, attempts, done_at FROM watchlist_effect$/,
 /^DROP TABLE watchlist_effect$/,
 /^ALTER TABLE watchlist_effect_v37 RENAME TO watchlist_effect$/,
 /^CREATE TRIGGER watchlist_effect_monotonic\s+BEFORE UPDATE ON watchlist_effect\b/,
 /^INSERT INTO watchlist_membership_authority \(id, mode, generation, baseline_version, changed_at\) VALUES \(1, 'producer', 0, NULL, '1970-01-01T00:00:00\.000Z'\)$/,
 /^UPDATE schema_contract\s+SET version = 37,[\s\S]*WHERE id = 1 AND version = 36$/,
];
export function migrationSql(bytes=migrationBytes()){
 if(!approved(bytes))throw new OperatorStop('migration_not_approved',3);
 const statements=migrationStatements(bytes.toString('utf8'));
 const shaped=statements.length===EXPECTED_STATEMENTS&&statements.every((sql,index)=>SHAPES[index].test(sql))
  &&!statements.some(sql=>/\b(COMMIT|ATTACH|DETACH|DELETE FROM|PRAGMA|VACUUM)\b/i.test(sql))
  &&statements.filter(sql=>/\bDROP\b/i.test(sql)).length===1&&statements.filter(sql=>/^ALTER\b/i.test(sql)).length===1;
 if(!shaped)throw new OperatorStop('migration_refused',3);
 return statements;
}

const rowsOf=async(binding,sql)=>(await binding.prepare(sql).bind().all()).results;
const num=value=>value==null?null:Number(value);
// The content of watchlist_effect as one digest (every column, a fixed order), so the readback proves the rebuild copied every row unchanged. Rows are never printed.
const effectDigest=rows=>sha256(JSON.stringify(rows.map(row=>[row.snapshot_id,row.effect,row.status,row.receipt??null,num(row.attempts),row.done_at??null])));
export async function readState(binding){
 try{
  const contract=(await rowsOf(binding,'SELECT id, version FROM schema_contract ORDER BY id, version')).map(row=>({id:num(row.id),version:num(row.version)}));
  const master=await rowsOf(binding,"SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')");
  const names=type=>new Set(master.filter(row=>row.type===type).map(row=>row.name));
  const tables=names('table'),indexes=names('index'),triggers=names('trigger');
  const effectSql=String(master.find(row=>row.type==='table'&&row.name==='watchlist_effect')?.sql||'');
  const state={
   contract,schemaVersion:contract.length===1&&contract[0].id===1?contract[0].version:null,
   predecessorIndexes:PREDECESSOR_INDEXES.filter(name=>indexes.has(name)).length,neededTables:NEEDED_TABLES.filter(name=>tables.has(name)).length,
   newTables:NEW_TABLES.filter(name=>tables.has(name)),newTriggers:NEW_TRIGGERS.filter(name=>triggers.has(name)),newIndex:indexes.has(NEW_INDEX),scratch:tables.has(SCRATCH_TABLE),
   effectTrigger:triggers.has(EFFECT_TRIGGER),effectAllowsMembership:/'membership'/.test(effectSql),
   watchlist:null,current:null,effects:null,marker:null,published:null,film:null,
  };
  const one=async sql=>(await rowsOf(binding,sql))[0]??null;
  if(tables.has('watchlist_authority')){const row=await one('SELECT mode, generation, writes FROM watchlist_authority WHERE id=1');state.watchlist=row?{mode:row.mode,generation:num(row.generation),writes:row.writes}:null;}
  if(tables.has('watchlist_current')){const row=await one('SELECT version, snapshot_id AS snapshotId, effects_drained_version AS drained FROM watchlist_current WHERE id=1');state.current=row?{version:num(row.version),snapshotId:row.snapshotId??null,drained:num(row.drained)}:null;}
  if(tables.has('watchlist_effect')){
   const rows=await rowsOf(binding,'SELECT snapshot_id, effect, status, receipt, attempts, done_at FROM watchlist_effect ORDER BY snapshot_id, effect');
   const byEffect={};for(const row of rows)byEffect[row.effect]=(byEffect[row.effect]||0)+1;
   state.effects={rows:rows.length,pending:rows.filter(row=>row.status!=='done').length,byEffect,digest:effectDigest(rows)};
  }
  if(tables.has('watchlist_membership_authority')){const row=await one('SELECT mode, generation, baseline_version AS baselineVersion FROM watchlist_membership_authority WHERE id=1');state.marker=row?{mode:row.mode,generation:num(row.generation),baselineVersion:num(row.baselineVersion)}:null;}
  if(tables.has('published_epg_authority')){const row=await one('SELECT mode, cutover, generation FROM published_epg_authority WHERE id=1');state.published=row?{mode:row.mode,cutover:row.cutover,generation:num(row.generation)}:null;}
  if(tables.has('watchlist_film')){const row=await one('SELECT COUNT(*) AS n FROM watchlist_film');state.film={rows:num(row?.n)};}
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}
const anyNew=state=>state.newTables.length>0||state.newTriggers.length>0||state.newIndex||state.scratch||state.effectAllowsMembership;
export function applyDecision(state){
 if(state.schemaVersion===null)return 'schema_contract_unexpected';
 if(state.schemaVersion===37){
  const complete=state.newTables.length===NEW_TABLES.length&&state.newTriggers.length===NEW_TRIGGERS.length&&state.newIndex&&!state.scratch&&state.effectTrigger&&state.effectAllowsMembership&&state.marker;
  return complete?'already_applied':'partial_schema';
 }
 if(state.schemaVersion===35)return 'predecessor_0036_not_applied';
 if(state.schemaVersion!==36)return 'schema_unexpected';
 if(anyNew(state))return 'partial_schema';
 if(state.predecessorIndexes!==PREDECESSOR_INDEXES.length)return 'predecessor_incomplete';
 if(state.neededTables!==NEEDED_TABLES.length||!state.effectTrigger)return 'needed_objects_missing';
 if(!state.current||!state.effects||!state.watchlist||!state.published||!state.film)return 'state_unreadable';
 // A quiet Watchlist: every effect of the current version is done. A pending effect means a Letterboxd slot is (or was left) mid-drain; the rebuild copies it correctly, but the window is not quiet.
 if(state.effects.pending>0||state.current.drained!==state.current.version)return 'watchlist_effects_pending';
 return 'apply';
}
export const view=state=>state?({schemaVersion:state.schemaVersion,schemaContractRows:state.contract.length,predecessorIndexes:state.predecessorIndexes+'/'+PREDECESSOR_INDEXES.length,
 neededTables:state.neededTables+'/'+NEEDED_TABLES.length,newTables:state.newTables,newTriggers:state.newTriggers,newIndex:state.newIndex,scratchTable:state.scratch,effectAllowsMembership:state.effectAllowsMembership,
 watchlist:state.watchlist,current:state.current?{version:state.current.version,drained:state.current.drained}:null,effects:state.effects?{rows:state.effects.rows,pending:state.effects.pending,byEffect:state.effects.byEffect}:null,
 marker:state.marker,published:state.published,watchlistFilmRows:state.film?.rows??null}):null;

async function write(binding,statements,ctx){
 ctx.track('unknown');
 try{await binding.batch(statements);}
 catch(error){
  if(error instanceof OperatorStop){ctx.track('none');throw error;}
  let after=null;try{after=await readState(binding);}catch{after=null;}
  // Only a PROVEN statement rejection with the state read back unchanged (still v36, no 0037 object) may end as "not applied". Everything else stays write_uncertain and is never retried.
  const clean=error instanceof D1Error&&error.kind==='statement'&&Boolean(after)&&after.schemaVersion===36&&!anyNew(after);
  ctx.track(clean?'none':'unknown');
  throw new OperatorStop(clean?'statement_failed':'write_uncertain',3,{state:view(after)});
 }
}

// The read-only baseline preflight over the production binding: the exact library planner the Worker will use, with read ports only.
export async function baselineDryRun(binding){
 const env={DB:binding};
 const baseline=membershipBaseline({
  repository:{readCurrentMembers},
  readStored:async e=>(await rowsOf(e.DB,'SELECT film_id FROM watchlist_film')).map(row=>row.film_id),
  resolve:(e,lids)=>resolveSourceIdentitiesEach(e,lids),
 });
 const out=await baseline.dryRun({env});
 if(!out.ok)throw new OperatorStop(out.reason||'baseline_unreadable',3,out.version!=null?{version:out.version}:{});
 return {operation:'baseline_dry_run',writes:false,writeState:'none',version:out.version,decision:out.decision,counts:out.counts};
}

export async function execute(command,{binding,ctx={track:()=>{}},params={},bytes=migrationBytes()}){
 if(command==='baseline-dry-run')return baselineDryRun(binding);
 const before=await readState(binding);
 const digest=migrationSha256(bytes);
 const decision=approved(bytes)?applyDecision(before):'migration_not_approved';
 if(command==='status')return {operation:'status',writes:false,writeState:'none',migrationSha256:digest,statements:approved(bytes)?migrationSql(bytes).length:null,approvedGitBlob:APPROVED_GIT_BLOB,approvedSha256Match:approved(bytes),decision,...view(before)};
 if(params.migrationSha256!==digest)throw new OperatorStop('migration_sha256_mismatch',3);
 if(decision!=='apply')throw new OperatorStop(decision,3);
 await write(binding,migrationSql(bytes).map(sql=>binding.prepare(sql).bind()),ctx);
 let after;
 try{after=await readState(binding);}
 catch{ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}
 const problems=[];
 if(after.schemaVersion!==37)problems.push('schema_version');
 if(after.newTables.length!==NEW_TABLES.length)problems.push('tables_missing');
 if(after.newTriggers.length!==NEW_TRIGGERS.length)problems.push('triggers_missing');
 if(!after.newIndex)problems.push('index_missing');
 if(after.scratch)problems.push('scratch_table_left');
 if(!after.effectTrigger)problems.push('effect_trigger_missing');
 if(!after.effectAllowsMembership)problems.push('effect_check');
 if(JSON.stringify(after.marker)!==JSON.stringify({mode:'producer',generation:0,baselineVersion:null}))problems.push('marker');
 if(after.effects?.rows!==before.effects.rows||after.effects?.digest!==before.effects.digest)problems.push('effects_changed');
 if(after.predecessorIndexes!==before.predecessorIndexes)problems.push('predecessor_changed');
 for(const key of ['watchlist','current','published','film'])if(JSON.stringify(after[key])!==JSON.stringify(before[key]))problems.push('changed:'+key);
 if(problems.length){ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,state:view(after)});}
 ctx.track('committed');
 return {operation:'apply',writes:true,writeState:'committed',migrationSha256:digest,statements:EXPECTED_STATEMENTS,before:view(before),after:view(after)};
}

export function parseArgs(argv){
 const args=argv.slice(2);
 const commands=args.filter(arg=>COMMANDS.includes(arg));
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
 if(command!=='apply'){if(parsed.confirm!==undefined||parsed.migrationSha256!==undefined)throw new OperatorStop('usage',2);return {command,params:{}};}
 if(parsed.confirm!=='apply')throw new OperatorStop('confirm',2);
 if(!/^[0-9a-f]{64}$/.test(parsed.migrationSha256||''))throw new OperatorStop('usage',2);
 return {command,params:{migrationSha256:parsed.migrationSha256}};
}

export async function runWatchlistMembership0037Production({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,deps=null}={}){
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
 const {exit,result}=await runWatchlistMembership0037Production();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
