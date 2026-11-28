#!/usr/bin/env node
// Owner-only production operator of the Catalog Enrichment RATED scope activation (card C2, AIR-607; ADR 0207 decision 7, ADR 0219 decisions 2, 3 and 6).
// THIN: it adds no activation SQL. It runs the accepted `ratedActivationPreflight`, `activateRated` and `readActivation` of src/catalog-enrichment-activation.js (and the bootstrap of
// src/catalog-enrichment-bootstrap.js it uses) over the existing strict D1 REST adapter pattern of scripts/upstream-cooldown-mode-production.mjs, scripts/d1-migration-window-production.mjs and
// scripts/published-epg-production.mjs: pinned account and database `iptv`, the owner's `D1_BACKFILL_*` credentials from the environment (never printed), zero retries, one atomic D1 batch per
// write unit of the module (the scope insert, each bootstrap page, the control commit), strict reads, an independent readback, a Time Travel bookmark before and after, no blind re-run.
// DORMANT: merging it authorizes nothing. `--activate` is the one production write, and only a SEPARATE owner GO may approve it. It enables no other scope, sets no flag, creates no Scheduled Task,
// starts no manual enrichment, no backfill and no instance (the REST binding has no Workflow, so the wake is `deferred`: the reconcile cron, delivered BEFORE this runs, starts the work).
//
//   --status    (default) strictly read-only. The digests of the bytes that run, the schema and authority facts, the preflight verdict for the optional `--cutoff` (`decision`: `ready`, `resume`,
//               `already_active` or `blocked` with the problem codes), the control, the scope rows and the inbox counts. No write, no request to any upstream.
//   --activate  --target iptv --cutoff <UTC ISO with milliseconds> --by <operator id> --go <HTTPS link of the recorded owner GO> --confirm activate --operator-sha256 <64 hex>
//               The cutoff is the value the owner confirmed in the GO; it is never defaulted. `--operator-sha256` is the digest `--status` printed. The call is `activateRated` with `at` = now. A repeated call
//               with the same cutoff is allowed ONLY after a confirmed `stopped` partial state, with an unchanged permitted configuration and within the GO: read `--status` first. `refused`, an unexpected
//               `stopped`, `uncertain` and a lost response end the run: reconcile the real state read-only before anything else; never retry blindly and never bypass a guard.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {activateRated,activeConfigurationReasons,cutoffProblems,ratedActivationPreflight,readActivation} from '../src/catalog-enrichment-activation.js';

export const OPERATOR_PATH=fileURLToPath(import.meta.url);
const ROOT=path.resolve(path.dirname(OPERATOR_PATH),'..');
// The bytes that run: this operator and the two modules whose code performs the writes. The pinned digest covers all three, so a changed module changes the digest the owner approved.
export const PINNED_FILES=Object.freeze(['scripts/catalog-enrichment-activation-production.mjs','src/catalog-enrichment-activation.js','src/catalog-enrichment-bootstrap.js']);
export const COMMANDS=['status','activate'];
const OPTIONS={'--target':'target','--cutoff':'cutoff','--by':'by','--go':'go','--confirm':'confirm','--operator-sha256':'operatorSha256'};
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const instant=value=>typeof value==='string'&&ISO.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;
const sha256=value=>createHash('sha256').update(value).digest('hex');
export const fileDigests=()=>PINNED_FILES.map(file=>({file,sha256:sha256(fs.readFileSync(path.join(ROOT,file)))}));
export const operatorSha256=()=>sha256(fileDigests().map(item=>item.file+':'+item.sha256).join('\n'));

// ---- the decision of one status read ----
// `inspection`: no cutoff was supplied, so the read is an observation and claims no readiness. With an exact cutoff the decision is `ready`, `resume` (the same cutoff, an interrupted activation), `already_active` (the very
// predicate `activateRated` uses for its noop), `blocked` (with the problem codes and, for an active control, the reasons) or `unstable` (the control or a scope changed between the two reads of this status).
// Everything is judged from the ONE preflight snapshot and then compared with the readback; a missing or unreadable schema is `blocked`, never ready. Exit 0 of a status is a successful observation, not an authorization.
export function decide({preflight,readback,cutoffAt,at}){
 if(cutoffAt!==null){
  const invalid=cutoffProblems(cutoffAt,at);
  if(invalid.length)return {decision:'blocked',problems:invalid};
 }
 const facts=preflight.facts||{};
 if(!facts.control||!Array.isArray(facts.scopes))return {decision:'blocked',problems:preflight.problems.length?preflight.problems:['state_unreadable']};
 if(!readback)return {decision:'blocked',problems:['state_unreadable']};
 const same=JSON.stringify([facts.control.state,facts.control.generation,facts.control.revision,facts.scopes])===JSON.stringify([readback.control.state,readback.control.generation,readback.control.revision,readback.scopes]);
 if(!same)return {decision:'unstable',problems:['state_changed_during_read']};
 if(facts.control.state==='active'){
  const reasons=activeConfigurationReasons(facts.scopes,cutoffAt);
  if(cutoffAt===null)return {decision:'inspection',problems:[],reasons};
  return reasons.length?{decision:'blocked',problems:['active_configuration_mismatch'],reasons}:{decision:'already_active',problems:[]};
 }
 if(cutoffAt===null)return {decision:'inspection',problems:preflight.problems};
 if(!preflight.ok)return {decision:'blocked',problems:preflight.problems};
 return {decision:facts.resume?'resume':'ready',problems:[]};
}

export async function execute(command,{binding,now,ctx={},params={}}){
 const clock=typeof now==='function'?now():now;
 const at=new Date(clock).toISOString();
 if(command==='status'){
  const cutoffAt=params.cutoff??null;
  const preflight=await ratedActivationPreflight(binding,{cutoffAt,now:at});
  let readback=null;
  try{readback=await readActivation(binding);}catch{readback=null;} // a missing table makes the readback unreadable: a blocked status, not an error and never ready
  const verdict=decide({preflight,readback,cutoffAt,at});
  return {operation:'status',writes:false,writeState:'none',at,mode:cutoffAt===null?'inspection':'exact_cutoff',operatorSha256:operatorSha256(),files:fileDigests(),cutoffAt,decision:verdict.decision,problems:verdict.problems,...(verdict.reasons?{reasons:verdict.reasons}:{}),facts:preflight.facts,...(readback||{})};
 }
 if(command!=='activate')throw new OperatorStop('usage',2);
 if(params.operatorSha256!==operatorSha256())throw new OperatorStop('operator_digest_mismatch',3);
 if(ctx.track)ctx.track('none');
 // `activateRated` re-validates the input (calendar instant, cutoff not in the future, GO link, combined actor length) before it reads the database.
 const result=await activateRated(binding,{cutoffAt:params.cutoff,by:params.by,at,goReference:params.go},{});
 return {operation:'activate',at,operatorSha256:operatorSha256(),cutoffAt:params.cutoff,...result};
}

// ---- CLI ----
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
 if(parsed.cutoff!==undefined&&!instant(parsed.cutoff))throw new OperatorStop('cutoff_invalid',2);
 if(command==='status'){
  if(Object.keys(parsed).some(key=>key!=='target'&&key!=='cutoff'))throw new OperatorStop('usage',2);
  return {command,params:{cutoff:parsed.cutoff??null}};
 }
 if(parsed.confirm!=='activate')throw new OperatorStop('confirm',2);
 if(parsed.cutoff===undefined)throw new OperatorStop('cutoff_required',2);
 if(!/^[A-Za-z0-9._:@+-]{1,120}$/.test(parsed.by||''))throw new OperatorStop('usage',2);
 if(!/^https:\/\/[^\s]{8,300}$/.test(parsed.go||''))throw new OperatorStop('go_reference_required',2);
 if(!/^[0-9a-f]{64}$/.test(parsed.operatorSha256||''))throw new OperatorStop('usage',2);
 return {command,params:{cutoff:parsed.cutoff,by:parsed.by,go:parsed.go,operatorSha256:parsed.operatorSha256}};
}

// Strict reads WITH parameters. `createPublishedBinding` reads through `adapter.all`, which turns a response without a result array into [] and would let a malformed control, scope or marker answer pass for an
// absent row. Every read here goes through the adapter's `allStrict`, so a malformed answer is an error before anything is written. The write path (`batch`, one atomic D1 batch of rendered statements) stays the
// published binding's, and the rendered statement text is the one the strict read would send.
export const strictBinding=(binding,adapter)=>({...binding,prepare:sql=>({bind:(...params)=>{
 const inner=binding.prepare(sql).bind(...params);
 return {...inner,async all(){return {results:await adapter.allStrict(sql,params)};},async first(){return (await adapter.allStrict(sql,params))[0]??null;}};
}})});

// The exit code and the DOMAIN write state of one `activateRated` outcome, judged from the module's own outcome and confirmed effects, never from the delivery of an SQL batch. A batch that committed and changed no
// row (a guarded insert whose guard failed) is not a write; a later failure never erases earlier confirmed effects (they stay in `effects`); an effect that no response or readback can establish is unknown.
//   writes: true (confirmed rows changed), false (confirmed none), null (unknown). Only `activated` and `noop` are successes.
export function judge(result){
 const outcome=result.outcome;
 if(outcome==='activated')return {exit:0,writeState:'committed',writes:true};
 if(outcome==='noop')return {exit:0,writeState:'none',writes:false};
 if(outcome==='uncertain')return {exit:3,writeState:'unknown',writes:null};
 const effects=result.effects||{scopeInserted:false,bootstrapRows:0,bootstrapPages:0};
 if(effects.scopeInserted==='unknown')return {exit:3,writeState:'unknown',writes:null};
 // a confirmed change of the scope (its insert, processed admissions, or a bootstrap cursor/state change even with zero rows) is a domain write
 if(effects.scopeInserted===true||effects.bootstrapRows>0||effects.bootstrapPages>0)return {exit:3,writeState:'partial',writes:true,partial:true};
 return {exit:3,writeState:'none',writes:false};
}

export async function runCatalogEnrichmentActivationProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,adapterTarget=null,tracked=null;
  if(deps)({binding}=deps);
  else{
   adapterTarget=productionTarget(env);
   if(adapterTarget.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
   const adapter=createD1Adapter({target:adapterTarget,databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   tracked=trackProductionWrites(adapter,ctx);
   binding=strictBinding(createPublishedBinding(tracked),adapter);
   // The Time Travel bookmark before the write is the recovery point; no restore without a separate GO. The stop control is the pause of the existing owner route, not a restore.
   if(parsed.command==='activate')ctx.bookmark=await readBookmark(adapterTarget,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,now,ctx:{track:state=>{if(!tracked)ctx.writeState=state;}},params:parsed.params});
  let after=null;
  if(parsed.command==='activate'&&adapterTarget)try{after=await readBookmark(adapterTarget,fetchImpl);}catch{after=null;}
  const bookmarks={...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(after?{bookmarkAfter:after}:{})};
  if(parsed.command==='status')return {exit:0,result:{...result,...bookmarks}};
  const verdict=judge(result);
  return {exit:verdict.exit,result:{...result,...bookmarks,writeState:verdict.writeState,writes:verdict.writes,...(verdict.partial?{partial:true}:{}),transport:{lastBatch:ctx.writeState},...(verdict.exit?{reason:result.reason||result.problems?.[0]||result.outcome,retry:false}:{})}};
 }catch(error){
  const stop=normalize(error);
  // an error mid-run: if any batch was sent, what it changed cannot be established here (the module's effects were lost with the exception), so the domain state is unknown; the delivery telemetry stays separate
  const sent=ctx.writeState==='committed'||ctx.writeState==='unknown';
  const writeState=sent?'unknown':'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:sent?null:false,transport:{lastBatch:ctx.writeState},...(sent?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmark:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runCatalogEnrichmentActivationProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
