#!/usr/bin/env node
// Owner-only operator of migration 0038, the Canonical Producer outcome outbox (AIR-594, ADR 0208 Accepted option B). DORMANT: merging it authorizes nothing.
// `--apply` is the single schema-only production write a SEPARATE owner GO may approve (D1 schema v37 -> v38) and nothing else: no row, marker, authority,
// lease, flag, Task or Workflow. Modeled on the verified 0036/0037 operators (pinned target, pinned bytes, zero retries, one atomic batch, readback, no blind re-run).
//
//   --status   (default) strictly read-only: pinned target identity, the SHA-256 and Git blob of the exact bytes of migrations/0038, schema_contract, every outbox
//              object (none may exist at v37), the predecessor tables, the Film/Person, published EPG and Watchlist membership markers, the Producer quiet window
//              (no chain with a live owner lease; not within the minutes around the hourly reconcile at :00 UTC), the row counts the apply must leave unchanged,
//              the runtime schema probe verdict (`readOutcomeSchema`, the same code the Worker runs), the decision and its reason. Counts and codes only.
//   --apply    --target iptv --confirm apply --migration-sha256 <full SHA-256 from status>: ONE atomic D1 batch of the 11 statements migrationStatements() extracts
//              from the unchanged file (guard, table, index, six outbox triggers, the downgrade trigger IF NOT EXISTS, the version update), then an independent
//              readback. Never split, never retried: an unclear answer is `write_uncertain` and the operator stops.
//
// There is no rollback: schema_contract.version never goes down and the table refuses DELETE. The empty table is inert until the Producer writes it.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {OUTCOME_TRIGGERS,readOutcomeSchema} from '../src/canonical-producer-events.js';
import {CHAIN_BOUNDARY_MARGIN_MS} from '../src/canonical-producer-fence.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0038_canonical_producer_outcome.sql');
// The migration ADR 0208 approved, pinned INDEPENDENTLY of the status/apply pin the caller passes: the exact bytes of migrations/0038
// (Git blob d04330c9e0d8d8a685d4a41c5e0833aa03fdb675, merged on main 26cfd115, 24 Nov 2026).
export const APPROVED_SHA256='bf5d70c117d0155b8168df6b82e99fa682b85db1b6e2e92255c83872a3a91900';
export const APPROVED_GIT_BLOB='d04330c9e0d8d8a685d4a41c5e0833aa03fdb675';
export const TABLE='canonical_producer_outcome';
export const INDEX='canonical_producer_outcome_pending';
export const NEEDED_TABLES=['schema_contract','film_person_authority','published_epg_authority','canonical_producer_run','canonical_producer_chain','watchlist_membership_authority'];
export const EXPECTED_STATEMENTS=11;
// The hourly cron fires at :00 UTC and runs the Producer reconcile, which probes the schema once per tick. The apply stays out of the minutes around it, so no
// tick probes `absent` and then acts after the commit (ADR 0208: outcomes of an inactive moment are not reported; the window keeps that moment empty).
export const TICK_GUARD_MINUTES=5;
// The status reads take a few REST round trips; the quiet-window observation they make is valid only for a short time. The apply re-reads the real clock at the
// write boundary and refuses when the preflight took longer than this, or when the write boundary falls inside the tick guard.
export const PREFLIGHT_MAX_MS=60000;
const OPTIONS={'--target':'target','--confirm':'confirm','--migration-sha256':'migrationSha256'};
const sha256=value=>createHash('sha256').update(value).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');
const squash=text=>String(text||'').replace(/\s+/g,' ').trim();

export const migrationBytes=()=>fs.readFileSync(MIGRATION_PATH);
export const migrationSha256=(bytes=migrationBytes())=>sha256(bytes);
export const approved=(bytes=migrationBytes())=>sha256(bytes)===APPROVED_SHA256&&gitBlob(bytes)===APPROVED_GIT_BLOB;
// The statements the REST batch gets: exactly those migrationStatements() extracts, checked for their shape and position.
export function migrationSql(bytes=migrationBytes()){
 if(!approved(bytes))throw new OperatorStop('migration_not_approved',3);
 const statements=migrationStatements(bytes.toString('utf8'));
 const triggers=statements.slice(3,9);
 const shaped=statements.length===EXPECTED_STATEMENTS
  &&/^INSERT INTO schema_contract\b[\s\S]*\bversion = 37\b/i.test(statements[0]||'')
  &&/^CREATE TABLE canonical_producer_outcome \(/.test(statements[1]||'')&&/\)\s*STRICT$/.test(statements[1]||'')
  &&/^CREATE INDEX canonical_producer_outcome_pending ON canonical_producer_outcome \(next_attempt_at, at, id\) WHERE state = 'pending'$/.test(statements[2]||'')
  &&triggers.every((sql,i)=>sql.startsWith('CREATE TRIGGER '+OUTCOME_TRIGGERS[i]+'\n')&&/ON canonical_producer_outcome\n/.test(sql))
  &&/^CREATE TRIGGER IF NOT EXISTS schema_contract_no_downgrade\b/.test(statements[9]||'')
  &&/^UPDATE schema_contract\b[\s\S]*SET version = 38[\s\S]*\bWHERE id = 1 AND version = 37$/i.test(statements[10]||'')
  &&!statements.some(sql=>/\b(COMMIT|DROP|ATTACH|ALTER|VACUUM|PRAGMA)\b/i.test(sql))
  &&!statements.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)&&!/schema_contract/.test(sql.split('\n')[0]));
 if(!shaped)throw new OperatorStop('migration_refused',3);
 return statements;
}
// The CREATE text of every object the file makes, by name: the readback compares what D1 stored with it.
export function expectedObjects(bytes=migrationBytes()){
 const statements=migrationSql(bytes);
 return {[TABLE]:statements[1],[INDEX]:statements[2],...Object.fromEntries(OUTCOME_TRIGGERS.map((name,i)=>[name,statements[3+i]]))};
}

const rowsOf=async(binding,sql)=>(await binding.prepare(sql).bind().all()).results;
const num=value=>value===null||value===undefined?null:Number(value);
// The exact runtime probe of the Worker, over the operator's binding (whose statements are prepared then bound).
const probeEnv=binding=>({DB:{prepare:sql=>{const statement=binding.prepare(sql).bind();return {first:()=>statement.first()};}}});

export async function readState(binding,{clock=Date.now,bytes=migrationBytes()}={}){
 try{
  const contract=(await rowsOf(binding,'SELECT id, version, typeof(version) AS kind FROM schema_contract ORDER BY id, version')).map(row=>({id:num(row.id),version:num(row.version),kind:row.kind}));
  const master=await rowsOf(binding,"SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table','index','trigger')");
  const tables=new Set(master.filter(row=>row.type==='table').map(row=>row.name));
  const outbox=master.filter(row=>row.name.startsWith(TABLE)).map(row=>({type:row.type,name:row.name,sql:row.sql}));
  const one=async sql=>(await rowsOf(binding,sql))[0]??null;
  const state={
   contract,schemaVersion:contract.length===1&&contract[0].id===1&&contract[0].kind==='integer'?contract[0].version:null,
   neededTables:NEEDED_TABLES.filter(name=>tables.has(name)),outboxObjects:outbox.map(row=>row.type+':'+row.name).sort(),outboxSql:Object.fromEntries(outbox.map(row=>[row.name,row.sql])),
   filmPerson:null,published:null,membership:null,producer:null,counts:null,probe:null,
  };
  if(tables.has('film_person_authority')){const row=await one('SELECT mode, cutover, generation FROM film_person_authority WHERE id=1');state.filmPerson=row?{mode:row.mode,cutover:row.cutover,generation:num(row.generation)}:null;}
  if(tables.has('published_epg_authority')){const row=await one('SELECT mode, cutover, generation, programme_run_id AS programmeRunId FROM published_epg_authority WHERE id=1');state.published=row?{mode:row.mode,cutover:row.cutover??null,generation:num(row.generation),programmeRunId:row.programmeRunId??null}:null;}
  if(tables.has('watchlist_membership_authority')){const row=await one('SELECT mode, generation FROM watchlist_membership_authority WHERE id=1');state.membership=row?{mode:row.mode,generation:num(row.generation)}:null;}
  if(tables.has('canonical_producer_chain')&&tables.has('canonical_producer_run')){
   const chains=await rowsOf(binding,"SELECT owner_state AS state, owner_epoch AS epoch, lease_expires_at AS lease, revision FROM canonical_producer_chain WHERE owner_state IN ('pending','active','released') ORDER BY programme_run_id");
   // Read the clock AFTER the chain rows. A `pending` chain is busy whatever its lease says: its Workflow instance may claim it at any moment, and a lapsed pending
   // lease is taken over by the next reconcile into a new pending one. An `active` lease counts as live until it is past the Producer's own boundary margin
   // (the reconcile takes a chain over only when lease + CHAIN_BOUNDARY_MARGIN_MS is before now).
   const nowMs=clock();
   const live=chains.filter(row=>row.state==='pending'||(row.state==='active'&&!(Date.parse(row.lease)+CHAIN_BOUNDARY_MARGIN_MS<nowMs)));
   state.producer={openChains:chains.length,liveLeases:live.length,openStates:chains.map(row=>row.state).sort()};
   const row=await one('SELECT (SELECT COUNT(*) FROM canonical_producer_chain) AS chains, (SELECT COALESCE(SUM(revision),0) FROM canonical_producer_chain) AS chainRevisions, (SELECT COUNT(*) FROM canonical_producer_run) AS runs, (SELECT COALESCE(SUM(revision),0) FROM canonical_producer_run) AS runRevisions');
   state.counts={chains:num(row.chains),chainRevisions:num(row.chainRevisions),runs:num(row.runs),runRevisions:num(row.runRevisions)};
  }
  try{state.probe=await readOutcomeSchema(probeEnv(binding));}catch(error){state.probe=error?.code||'producer_outcome_schema_unreadable';}
  // The stored CREATE text of every outbox object against the file (whitespace-normalized): the same check the apply readback makes, so a later `--status` after an
  // uncertain apply can never call a same-name object with another body `already_applied`.
  state.outboxMismatches=outbox.length&&approved(bytes)?Object.entries(expectedObjects(bytes)).filter(([name,sql])=>squash(state.outboxSql[name])!==squash(sql)).map(([name])=>name):[];
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}
// Minutes since the last full UTC hour; the apply waits while it is within TICK_GUARD_MINUTES of a tick (either side).
// Inclusive on both sides: from :55:00.000 to :05:00.000 UTC (milliseconds included) the window is closed.
export const nearHourlyTick=nowMs=>{const date=new Date(nowMs);const intoHour=(date.getUTCMinutes()*60+date.getUTCSeconds())*1000+date.getUTCMilliseconds();return intoHour<=TICK_GUARD_MINUTES*60000||intoHour>=(60-TICK_GUARD_MINUTES)*60000;};
export function applyDecision(state,{nowMs=Date.now()}={}){
 if(state.schemaVersion===null)return 'schema_contract_unexpected';
 if(state.schemaVersion>=38)return state.schemaVersion===38&&state.contract.length===1&&state.probe==='active'&&state.outboxObjects.length===2+OUTCOME_TRIGGERS.length&&state.outboxMismatches.length===0?'already_applied':'partial_schema';
 if(state.schemaVersion!==37)return 'schema_unexpected';
 if(state.outboxObjects.length)return 'partial_schema';
 if(state.probe!=='absent')return 'probe_not_absent';
 if(state.neededTables.length!==NEEDED_TABLES.length)return 'predecessor_incomplete';
 if(!state.filmPerson||state.filmPerson.mode!=='d1'||state.filmPerson.cutover!=='open')return 'film_person_not_open';
 if(!state.published||state.published.mode!=='d1'||state.published.cutover!=='open')return 'published_not_open';
 if(!state.producer||!state.counts)return 'state_unreadable';
 if(state.producer.liveLeases>0)return 'producer_busy';
 if(nearHourlyTick(nowMs))return 'hourly_tick_window';
 return 'apply';
}
export const view=state=>state?({schemaVersion:state.schemaVersion,schemaContractRows:state.contract.length,neededTables:state.neededTables.length+'/'+NEEDED_TABLES.length,outboxObjects:state.outboxObjects,outboxMismatches:state.outboxMismatches,
 runtimeProbe:state.probe,filmPersonAuthority:state.filmPerson,publishedAuthority:state.published,membershipAuthority:state.membership,producer:state.producer,counts:state.counts}):null;

// The facts of the before-state a proven rejection must leave unchanged: not only "still v37 without an outbox object" but every recorded marker and count.
const FACTS=state=>JSON.stringify({contract:state.contract,needed:state.neededTables,outbox:state.outboxObjects,probe:state.probe,filmPerson:state.filmPerson,published:state.published,membership:state.membership,counts:state.counts});
async function write(binding,statements,ctx,before,{clock,bytes}){
 ctx.track('unknown');
 try{await binding.batch(statements);}
 catch(error){
  if(error instanceof OperatorStop){ctx.track('none');throw error;}
  let after=null;try{after=await readState(binding,{clock,bytes});}catch{after=null;}
  // Only a PROVEN statement rejection whose read-back state equals the recorded before-state in every fact may end as "not applied". Everything else stays
  // write_uncertain (a fact that moved may be another writer, but it is not proof that this batch wrote nothing).
  const clean=error instanceof D1Error&&error.kind==='statement'&&Boolean(after)&&after.schemaVersion===37&&after.outboxObjects.length===0&&FACTS(after)===FACTS(before);
  ctx.track(clean?'none':'unknown');
  throw new OperatorStop(clean?'statement_failed':'write_uncertain',3,{state:view(after)});
 }
}

export async function execute(command,{binding,ctx={track:()=>{}},params={},bytes=migrationBytes(),clock=Date.now}){
 const startedMs=clock();
 const before=await readState(binding,{clock,bytes});
 const digest=migrationSha256(bytes);
 const decidedMs=clock();
 const decision=approved(bytes)?applyDecision(before,{nowMs:decidedMs}):'migration_not_approved';
 if(command==='status')return {operation:'status',writes:false,writeState:'none',migrationSha256:digest,statements:approved(bytes)?migrationSql(bytes).length:null,approvedGitBlob:APPROVED_GIT_BLOB,approvedSha256Match:approved(bytes),
  at:new Date(decidedMs).toISOString(),decision,...view(before)};
 if(params.migrationSha256!==digest)throw new OperatorStop('migration_sha256_mismatch',3);
 if(decision!=='apply')throw new OperatorStop(decision,3);
 const statements=migrationSql(bytes).map(sql=>binding.prepare(sql).bind());
 // The write boundary: the real clock again, immediately before the batch. A preflight that crossed into the tick guard, or that took too long to stand for the
 // quiet window, refuses with nothing sent.
 const boundaryMs=clock();
 if(nearHourlyTick(boundaryMs))throw new OperatorStop('hourly_tick_window',3,{at:new Date(boundaryMs).toISOString()});
 if(boundaryMs-startedMs>PREFLIGHT_MAX_MS)throw new OperatorStop('preflight_stale',3,{elapsedMs:boundaryMs-startedMs});
 await write(binding,statements,ctx,before,{clock,bytes});
 let after,rows;
 try{after=await readState(binding,{clock,bytes});rows=(await rowsOf(binding,'SELECT COUNT(*) AS n FROM '+TABLE))[0];}
 catch{ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}
 const problems=[];
 if(after.schemaVersion!==38||after.contract.length!==1)problems.push('schema_version');
 if(after.probe!=='active')problems.push('runtime_probe:'+after.probe);
 if(after.outboxObjects.length!==2+OUTCOME_TRIGGERS.length)problems.push('outbox_objects');
 for(const name of after.outboxMismatches)problems.push('object_sql:'+name);
 if(Number(rows?.n)!==0)problems.push('table_not_empty');
 for(const key of ['filmPerson','published','membership','counts'])if(JSON.stringify(after[key])!==JSON.stringify(before[key]))problems.push('changed:'+key);
 if(problems.length){ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,state:view(after)});}
 ctx.track('committed');
 return {operation:'apply',writes:true,writeState:'committed',migrationSha256:digest,statements:EXPECTED_STATEMENTS,before:view(before),after:view(after),outboxRows:0};
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

export async function runProducerOutcome0038Production({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,deps=null,clock=Date.now}={}){
 const ctx={writeState:'none',bookmark:null,track(state){ctx.writeState=state;}};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,target=null;
  if(deps)({binding}=deps);
  else{
   target=productionTarget(env);
   if(target.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
   // retries:0: no request of this operator is ever repeated automatically (a write never is anyway).
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command==='apply')ctx.bookmark=await readBookmark(target,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,ctx,params:parsed.params,clock});
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
 const {exit,result}=await runProducerOutcome0038Production();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
