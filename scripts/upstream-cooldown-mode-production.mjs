#!/usr/bin/env node
// Owner-only production operator for ONE value: the mode row `upstream_coordination` of the shared upstream cooldown (ADR 0211 decision 5, ADR 0207 decision 7, AIR-609 / UC2).
// DORMANT: merging it authorizes nothing. `--set` is the only production write a SEPARATE owner GO may approve, and it can move the mode only
//   off -> observe   (the UC2 rollout: writers record cooldowns and count would-be skips; nothing is skipped)
//   observe -> off   (the rollback; needs no code revert)
// `enforce` is not reachable from here: it is UC3 and needs its own card, GO and operator change. No cooldown row, flag, Task, Access rule, R2 object or migration is touched.
// Modeled on the narrow control operators (scripts/letterboxd-sync-control-production.mjs): pinned target, pinned operator digest, one atomic batch of ONE statement, zero retries,
// independent readback, no blind re-run.
//
//   --status   (default) strictly read-only. Digest of this operator, the schema version, the two tables, the mode row (absent reads as `off`), every cooldown row with its expiry,
//              and the decision of each transition. Counts and codes only; no request is made to any upstream.
//   --set      --target iptv --mode observe|off --expect-revision <n> --confirm set --operator-sha256 <64 hex>
//              `--expect-revision` is the revision `--status` printed (0 for an absent row). Re-reads the whole state, requires the exact predecessor mode and revision, sends ONE
//              atomic D1 batch, then reads back the control row EXACTLY (mode, revision +1, the written `updated_at`, one row) and the unchanged schema version.
//              Natural callers are never stopped and no quiet window is taken: the moment the mode becomes `observe` a caller may legally write a cooldown, and after a rollback a run that
//              cached `observe` may still write until it ends. Cooldown rows that changed meanwhile are reported SEPARATELY as `cooldownObservations` (concurrent natural writes); they are not
//              evidence about the mode write, which is judged only from its own outcome and the control row. Every control-state read is strict (a response without a result array is an
//              error, never an empty table).
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';

export const OPERATOR_PATH=fileURLToPath(import.meta.url);
export const COMMANDS=['status','set'];
// The modes this operator may write, and the one predecessor each requires. `enforce` is deliberately absent.
export const TRANSITIONS=Object.freeze({observe:'off',off:'observe'});
export const SCOPES=['tmdb','letterboxd','wikidata'];
// Schema 47 is checkpoint A of the AIR-603 window (catalog enrichment control plane included); the cooldown tables themselves come with 45.
export const MIN_SCHEMA_VERSION=47;
const OPTIONS={'--target':'target','--confirm':'confirm','--mode':'mode','--expect-revision':'expectRevision','--operator-sha256':'operatorSha256'};
const sha256=value=>createHash('sha256').update(value).digest('hex');
export const operatorSha256=()=>sha256(fs.readFileSync(OPERATOR_PATH));
const num=value=>value===null||value===undefined?null:Number(value);

async function one(binding,sql){return (await binding.prepare(sql).bind().first())??null;}
async function many(binding,sql){return (await binding.prepare(sql).bind().all()).results||[];}

// The whole state this operator reasons about. Any unreadable part is `unknown_state`: it never guesses.
export async function readState(binding,{now=Date.now()}={}){
 try{
  const version=num((await one(binding,'SELECT version FROM schema_contract WHERE id=1'))?.version);
  const master=await many(binding,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('upstream_cooldown','upstream_coordination')");
  const has=name=>master.some(row=>row.name===name);
  const state={schemaVersion:Number.isFinite(version)?version:null,tables:{cooldown:has('upstream_cooldown'),coordination:has('upstream_coordination')},mode:null,rowRevision:null,rowUpdatedAt:null,rows:0,cooldowns:[],digest:null};
  if(state.tables.coordination){
   const mode=await many(binding,'SELECT id, mode, revision, updated_at FROM upstream_coordination ORDER BY id');
   state.rows=mode.length;
   if(mode.length>1||(mode.length===1&&Number(mode[0].id)!==1))throw new OperatorStop('unknown_state',3);
   if(mode.length===1){state.mode=String(mode[0].mode);state.rowRevision=num(mode[0].revision);state.rowUpdatedAt=num(mode[0].updated_at);}
  }
  if(state.tables.cooldown){
   const cooldowns=await many(binding,'SELECT scope, until_at, reason, retry_after_s, set_by, updated_at FROM upstream_cooldown ORDER BY scope');
   state.cooldowns=cooldowns.map(row=>({scope:String(row.scope),untilAt:num(row.until_at),reason:String(row.reason),retryAfterS:num(row.retry_after_s),setBy:String(row.set_by),updatedAt:num(row.updated_at),active:num(row.until_at)>now}));
   state.digest=sha256(JSON.stringify(cooldowns.map(row=>[row.scope,num(row.until_at),row.reason,num(row.retry_after_s),row.set_by,num(row.updated_at)])));
  }
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}

// The mode the Worker reads: an absent row, an absent table or an unknown value is `off` (src/upstream-cooldown.js readMode).
export const effectiveMode=state=>state.tables.coordination&&['off','observe','enforce'].includes(state.mode)?state.mode:'off';
export const revisionOf=state=>state.rowRevision===null?0:state.rowRevision;

// Decision of one transition to `mode`. `apply` is the only value that allows a write.
export function decide(state,mode,{expectRevision=null}={}){
 if(!Object.hasOwn(TRANSITIONS,mode))return 'mode_unsupported';
 if(state.schemaVersion===null)return 'unknown_state';
 if(!state.tables.cooldown||!state.tables.coordination)return 'tables_missing';
 if(state.schemaVersion<MIN_SCHEMA_VERSION)return 'schema_unexpected';
 if(state.rows===1&&!['off','observe','enforce'].includes(state.mode))return 'mode_unknown';
 if(effectiveMode(state)==='enforce')return 'enforce_active';
 if(effectiveMode(state)!==TRANSITIONS[mode])return effectiveMode(state)===mode?'already_set':'mode_unexpected';
 if(expectRevision!==null&&expectRevision!==revisionOf(state))return 'revision_moved';
 if(state.cooldowns.some(row=>!SCOPES.includes(row.scope)))return 'scope_unexpected';
 return 'apply';
}

// The single statement. Every value is a validated literal (a fixed mode, integers): nothing from the command line reaches the SQL text.
export function writeSql(state,mode,nowMs){
 if(!Object.hasOwn(TRANSITIONS,mode)||!Number.isSafeInteger(nowMs)||nowMs<0)throw new OperatorStop('usage',2);
 if(state.rows===0)return `INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, '${mode}', 1, ${nowMs})`;
 const revision=state.rowRevision;
 if(!Number.isSafeInteger(revision)||revision<1)throw new OperatorStop('unknown_state',3);
 return `UPDATE upstream_coordination SET mode = '${mode}', revision = revision + 1, updated_at = ${nowMs} WHERE id = 1 AND mode = '${TRANSITIONS[mode]}' AND revision = ${revision}`;
}

// What the independent readback must show after the write.
// Judged ONLY from the control row and the schema version: a cooldown that a natural caller wrote meanwhile is a separate observation (`cooldownObservations`), never a reason to doubt the write.
export function readbackProblems(after,before,mode,nowMs){
 const problems=[];
 if(after.mode!==mode)problems.push('mode');
 if(after.rowRevision!==revisionOf(before)+1)problems.push('revision');
 if(after.rowUpdatedAt!==nowMs)problems.push('updated_at');
 if(after.rows!==1)problems.push('rows');
 if(after.schemaVersion!==before.schemaVersion)problems.push('schema_version');
 return problems;
}

const view=(state,now)=>({schemaVersion:state.schemaVersion,tables:state.tables,mode:effectiveMode(state),modeRow:state.rows===1?{mode:state.mode,revision:state.rowRevision,updatedAt:state.rowUpdatedAt===null?null:new Date(state.rowUpdatedAt).toISOString()}:null,
 cooldowns:state.cooldowns.map(row=>({scope:row.scope,reason:row.reason,setBy:row.setBy,untilAt:new Date(row.untilAt).toISOString(),active:row.untilAt>now,remainingS:row.untilAt>now?Math.ceil((row.untilAt-now)/1000):0})),cooldownDigest:state.digest});

// The cooldown rows that moved between two reads, reported as observations of natural callers. A cooldown is only ever added or extended (triggers refuse a shortening and any delete), so
// anything else is listed as an anomaly for the owner to read; none of it decides the outcome of the mode write.
export function cooldownObservations(before,after){
 const was=new Map(before.cooldowns.map(row=>[row.scope,row]));
 const added=[],extended=[],anomalies=[];
 for(const row of after.cooldowns){
  const prior=was.get(row.scope);
  if(!prior)added.push(row.scope);
  else if(row.untilAt>prior.untilAt)extended.push(row.scope);
  else if(row.untilAt<prior.untilAt)anomalies.push('shortened:'+row.scope);
  was.delete(row.scope);
 }
 for(const scope of was.keys())anomalies.push('missing:'+scope);
 return {changed:before.digest!==after.digest,added,extended,...(anomalies.length?{anomalies}:{})};
}

export async function execute(command,{binding,now,ctx={},params={}}){
 const clock=typeof now==='function'?now():now;
 const state=await readState(binding,{now:clock});
 if(command==='status')return {operation:'status',writes:false,writeState:'none',operatorSha256:operatorSha256(),expectRevision:revisionOf(state),decisions:{observe:decide(state,'observe'),off:decide(state,'off')},...view(state,clock)};
 if(command!=='set')throw new OperatorStop('usage',2);
 const {mode,expectRevision}=params;
 if(params.operatorSha256!==operatorSha256())throw new OperatorStop('operator_digest_mismatch',3);
 const decision=decide(state,mode,{expectRevision});
 if(decision!=='apply')throw new OperatorStop(decision,3,{state:view(state,clock)});
 const sql=writeSql(state,mode,clock);
 if(ctx.track)ctx.track('unknown');
 try{await binding.batch([binding.prepare(sql).bind()]);}
 catch(error){
  // Only a PROVEN rejection (the D1 API answered with a statement error) of an unchanged state may end as "not applied". A lost response, a timeout or any unproven receipt stays
  // write_uncertain even when the immediate read still shows the old row: the request may still be executing or the commit may not be visible yet. Never retried.
  let after=null;
  try{after=await readState(binding,{now:clock});}catch{after=null;}
  const rejected=error instanceof D1Error&&error.kind==='statement';
  const untouched=rejected&&Boolean(after)&&after.mode===state.mode&&after.rowRevision===state.rowRevision&&after.rows===state.rows;
  if(ctx.track)ctx.track(untouched?'none':'unknown');
  throw new OperatorStop(untouched?'statement_failed':'write_uncertain',3,{mode:after?effectiveMode(after):null,revision:after?revisionOf(after):null});
 }
 let after;
 try{after=await readState(binding,{now:clock});}catch{throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}
 const problems=readbackProblems(after,state,mode,clock);
 const cooldownObservation=cooldownObservations(state,after);
 if(problems.length)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,after:view(after,clock),cooldownObservations:cooldownObservation});
 if(ctx.track)ctx.track('committed');
 return {operation:'set',writes:true,writeState:'committed',operatorSha256:operatorSha256(),mode,statements:1,before:view(state,clock),after:view(after,clock),cooldownObservations:cooldownObservation};
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
 if(command==='status'){if(Object.keys(parsed).some(key=>key!=='target'))throw new OperatorStop('usage',2);return {command,params:{}};}
 if(parsed.confirm!=='set')throw new OperatorStop('confirm',2);
 if(!Object.hasOwn(TRANSITIONS,parsed.mode||''))throw new OperatorStop(parsed.mode==='enforce'?'mode_unsupported':'usage',2);
 if(!/^\d{1,9}$/.test(parsed.expectRevision||''))throw new OperatorStop('usage',2);
 if(!/^[0-9a-f]{64}$/.test(parsed.operatorSha256||''))throw new OperatorStop('usage',2);
 return {command,params:{mode:parsed.mode,expectRevision:Number(parsed.expectRevision),operatorSha256:parsed.operatorSha256}};
}

// The production reads are strict: `createPublishedBinding` reads through `adapter.all`, which turns a response without a result array into [] and would let a malformed mode answer pass
// for an absent (`off`) row or a malformed cooldown answer for an empty table. Every read here goes through the adapter's `allStrict` (the AIR-603 mechanism) and a malformed answer is an error
// before anything is written. The write path (`batch`) stays the published binding's.
export const strictBinding=(binding,adapter)=>({...binding,prepare:sql=>({bind:(...params)=>{
 if(params.length)throw new OperatorStop('usage',2,{reason:'operator_binds_no_parameters'});
 return {text:sql,async all(){return {results:await adapter.allStrict(sql,[])};},async first(){return (await adapter.allStrict(sql,[]))[0]??null;}};
}})});

export async function runUpstreamCooldownModeProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,adapterTarget=null;
  if(deps)({binding}=deps);
  else{
   adapterTarget=productionTarget(env);
   if(adapterTarget.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
   const adapter=trackProductionWrites(createD1Adapter({target:adapterTarget,databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=strictBinding(createPublishedBinding(adapter),adapter);
   // A Time Travel bookmark before the write is the recovery point; no restore without a separate GO. The rollback of this value is the `observe -> off` transition, not a restore.
   if(parsed.command==='set')ctx.bookmark=await readBookmark(adapterTarget,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,now,ctx:{track},params:parsed.params});
  let after=null;
  if(parsed.command==='set'&&adapterTarget)try{after=await readBookmark(adapterTarget,fetchImpl);}catch{after=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(after?{bookmarkAfter:after}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runUpstreamCooldownModeProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
