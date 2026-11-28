#!/usr/bin/env node
// Owner-only production operator for the Letterboxd admission cutover of card A2 (AIR-608; ADR 0207 decision 1 and 7, ADR 0222). It is the reviewable, offline-tested wrapper around the delivered
// mechanism (`src/letterboxd-admission-documents-import.js`: inventory, planImport, importDocuments, verifyParity, rollbackImport) and the marker `letterboxd_admission_authority` (r2 -> closed -> d1, closed -> r2).
// It is NOT run by a deploy, a test or a Task. Default is read-only `status`. Every write command needs `--target iptv`, `--confirm <command>`, the pins named below and the owner's L3 GO for exactly that step.
//
//   status           read-only: schema, marker, Ratings authority, pending facts (receipts, chunk intents without receipt, admitting candidates, Diary link intents), C2 scope, the frozen R2 plan digest and the parity
//   parity           read-only: R2 snapshot vs D1 byte for byte (verifyParity) plus the pending facts; exit 3 on any drift or pending state
//   close            r2 G -> closed G+1       pins: --expect-generation. ONE guarded UPDATE of the marker row (the trigger of migration 0046 enforces the chain); nothing else is written
//   import           closed G (no marker move)  pins: --expect-generation, --expect-manifest-sha256 (printed by `status` for the frozen cohort); refuses unless the plan is not blocked, the pending facts are clean and the
//                    digest equals the pin; then importDocuments (create-only, idempotent, manifest last)
//   flip             closed G -> d1 G+1       pins: --expect-generation, --expect-manifest-sha256. Re-runs the full parity and the pending facts, requires C2 `rated` active with a cutoff, then ONE fenced batch: the closed marker at G,
//                    the manifest present, no pending receipt, and the marker update. IRREVERSIBLE (the trigger refuses d1 -> anything).
//   reopen           closed G -> r2 G+1       pins: --expect-generation. Pre-flip rollback of the marker only; the D1 copies are removed by `rollback-import` first
//   rollback-import  r2 or closed G (before the flip)  pins: --expect-generation. rollbackImport: deletes the D1 copies and the manifest in one fenced batch; R2 stays authoritative
//
// No retry, no repair, no delta: a refused or uncertain write ends in a readback and a STOP. Never calls Letterboxd, the Worker or the API. No document text, film name, code or rating is ever printed: only counts,
// key kinds, digests and generations.
import {pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {createS3Store} from './r2-s3-store.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';
import {inventory,MANIFEST_KEY,planImport,importDocuments,rollbackImport,verifyParity} from '../src/letterboxd-admission-documents-import.js';
import {readAdmissionAuthority} from '../src/letterboxd-admission-authority.js';
import {readOwned} from '../src/ratings-d1.js';
import {H1_RULES} from '../src/domain/letterboxd-lid-only-proof.js';

export const COMMANDS=['status','parity','close','import','flip','reopen','rollback-import'];
const WRITES=['close','import','flip','reopen','rollback-import'];
const NEEDS={close:['generation'],import:['generation','manifestSha256'],flip:['generation','manifestSha256'],reopen:['generation'],'rollback-import':['generation']};
const VALUE_FLAGS={'--target':'target','--confirm':'confirm','--expect-generation':'generation','--expect-manifest-sha256':'manifestSha256'};
export const DIARY_STATE_KEY='letterboxd/diary/state.json';
const LINK_REASONS=new Set(['linking','link_failed','lid_only_intent']);
const RECEIPT_ORIGIN='rated_admission_retention';

async function one(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).first())??null;}
async function many(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).all()).results||[];}

// ---- pure: what the frozen R2 cohort says is still in flight (a NO-GO under `closed`; nothing is repaired) ----------------------------------
// -> {admittingCandidates, chunksWithoutReceipt, documents}. Counts only. `plan` is the output of planImport (`documents[].value` is parsed).
export function pendingInR2(plan){
 let admitting=0,withoutReceipt=0;
 const keys=new Set(plan.documents.map(item=>item.key));
 for(const item of plan.documents){
  if(item.key.endsWith('/rated-candidates.json')){
   const candidates=item.value&&typeof item.value.candidates==='object'&&item.value.candidates?Object.values(item.value.candidates):[];
   for(const row of candidates)if(row&&row.state==='admitting')admitting++;
  }
  if(item.key.endsWith('.intent.json')&&!keys.has(item.key.replace(/\.intent\.json$/,'.receipt.json')))withoutReceipt++;
 }
 return {admittingCandidates:admitting,chunksWithoutReceipt:withoutReceipt,documents:plan.documents.length};
}
// Pure. Counts Diary entries that are link intents (`linking`, `link_failed`, `lid_only_intent`) anywhere in the state document.
export function diaryLinkIntents(value){
 let count=0;
 const walk=node=>{
  if(Array.isArray(node)){for(const item of node)walk(item);return;}
  if(node&&typeof node==='object'){if(typeof node.reason==='string'&&LINK_REASONS.has(node.reason))count++;for(const child of Object.values(node))if(child&&typeof child==='object')walk(child);}
 };
 walk(value);return count;
}

// ---- state (read only) ------------------------------------------------------------------------------------------------
export async function readState(binding){
 const env={DB:binding};
 try{
  const schema=await one(binding,'SELECT version FROM schema_contract WHERE id=1');
  const authority=await readAdmissionAuthority(env);
  const ratings=await one(binding,'SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1');
  const receipts=await one(binding,"SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE origin=? AND state='pending'",[RECEIPT_ORIGIN]);
  const scopes=await many(binding,'SELECT scope, activated, enabled, cutoff_at, bootstrap_state FROM catalog_enrichment_scope ORDER BY scope');
  const diary=await readOwned(env,DIARY_STATE_KEY);
  if(!diary.owned)throw new OperatorStop('unknown_state',3,{reason:'ratings_domain_unavailable'});
  return {
   version:schema?Number(schema.version):null,
   marker:{mode:authority.mode,generation:authority.generation,installed:authority.installed},
   ratings:ratings?{mode:ratings.mode,cutover:ratings.cutover,generation:Number(ratings.generation)}:null,
   pendingReceipts:receipts?Number(receipts.n):null,
   diaryLinkIntents:diaryLinkIntents(diary.value),
   scopes:scopes.map(row=>({scope:row.scope,activated:Number(row.activated),enabled:Number(row.enabled),cutoffAt:row.cutoff_at,bootstrap:row.bootstrap_state})),
   h1RulesEmpty:H1_RULES.eligibleTypes.length===0&&H1_RULES.idBlockMarker===null,
  };
 }catch(error){if(error instanceof OperatorStop)throw error;throw new OperatorStop('unknown_state',3,{reason:error&&error.code?String(error.code):'read_failed'});}
}
const view=state=>({schema:state.version,marker:state.marker,ratings:state.ratings});

export function ratedScopeActive(state){const row=state.scopes.find(item=>item.scope==='rated');return Boolean(row&&row.activated===1&&row.enabled===1&&row.cutoffAt);}

// The planner of the frozen cohort: inventory (R2 read only), then planImport. -> {plan, pending}
export async function frozenPlan(bucket){
 const snapshot=await inventory(bucket);
 const plan=planImport(snapshot);
 return {plan,pending:plan.manifest?pendingInR2(plan):null};
}
const blockers=({plan,pending},state)=>{
 const out=[];
 if(plan.blocked.length)out.push('plan_blocked');
 if(pending&&pending.admittingCandidates>0)out.push('admitting_candidates');
 if(pending&&pending.chunksWithoutReceipt>0)out.push('chunk_intent_without_receipt');
 if(state.pendingReceipts!==0)out.push('pending_receipts');
 if(state.diaryLinkIntents>0)out.push('diary_link_intents');
 return out;
};
const planView=({plan,pending})=>({blocked:plan.blocked.map(item=>({reason:item.reason})),documents:plan.documents.length,manifestSha256:plan.manifestSha256,inventorySha256:plan.manifest?plan.manifest.inventorySha256:null,pending});

// ---- the marker transitions (ONE guarded statement each; the trigger of migration 0046 enforces the chain) ----------------
const TRANSITIONS={
 close:{from:'r2',to:'closed',sql:"UPDATE letterboxd_admission_authority SET mode='closed', generation=? WHERE id=1 AND mode='r2' AND generation=?"},
 reopen:{from:'closed',to:'r2',sql:"UPDATE letterboxd_admission_authority SET mode='r2', generation=? WHERE id=1 AND mode='closed' AND generation=?"},
};
export function transitionStatements(command,{generation}){
 const spec=TRANSITIONS[command];
 if(!spec)throw new OperatorStop('usage',2);
 return {target:{mode:spec.to,generation:generation+1},statements:[[spec.sql,[generation+1,generation]]]};
}
// The flip: the assertion statements ride in the same batch as the marker update (a false condition fails the CHECK of `ratings_domain_cas` and rolls the whole batch back).
export function flipStatements({generation,activatedAt}){
 const assert=(sql,params)=>['UPDATE ratings_domain_cas SET ok=CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE id=1',params];
 return {
  target:{mode:'d1',generation:generation+1},
  statements:[
   assert("EXISTS (SELECT 1 FROM letterboxd_admission_authority WHERE id=1 AND mode='closed' AND generation=?)",[generation]),
   assert('(SELECT COUNT(*) FROM ratings_document WHERE key=? AND part=0)=1',[MANIFEST_KEY]),
   assert("NOT EXISTS (SELECT 1 FROM canonical_write_receipt WHERE origin=? AND state='pending')",[RECEIPT_ORIGIN]),
   assert("EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope='rated' AND activated=1 AND enabled=1 AND cutoff_at IS NOT NULL)",[]),
   ["UPDATE letterboxd_admission_authority SET mode='d1', generation=?, activated_at=? WHERE id=1 AND mode='closed' AND generation=?",[generation+1,activatedAt,generation]],
  ],
 };
}

async function applyBatch(binding,plan,ctx,reachedState,{unchangedState}){
 if(ctx.track)ctx.track('unknown');
 let failure=null;
 try{await binding.batch(plan.statements.map(([sql,params])=>binding.prepare(sql).bind(...params)));}catch(error){failure=error;}
 let after=null;
 try{after=await readState(binding);}catch{after=null;}
 const reached=Boolean(after)&&after.marker.mode===reachedState.mode&&after.marker.generation===reachedState.generation;
 const unchanged=Boolean(after)&&after.marker.mode===unchangedState.mode&&after.marker.generation===unchangedState.generation;
 if(failure){
  // Only a PROVEN statement rejection with the marker untouched is "not applied"; anything else stays unproven and is never downgraded by a readback.
  const rejected=failure instanceof D1Error&&failure.kind==='statement'&&unchanged;
  if(ctx.track)ctx.track(rejected?'none':'unknown');
  throw new OperatorStop(rejected?'predicate_refused':'write_uncertain',3,{marker:after?after.marker:null,...(reached?{reachedByUnknownOutcome:true}:{})});
 }
 if(!after||!reached)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',marker:after?after.marker:null});
 if(ctx.track)ctx.track('committed');
 return after;
}

// verifyParity throws on a document that cannot be read (a damaged part, an unavailable domain): that is a STOP with its own reason, never a silent `equal`.
async function parityOf(binding,plan,bucket){
 try{return await verifyParity({DB:binding},plan,bucket);}
 catch(error){throw new OperatorStop('parity_unreadable',3,{reason:error&&error.code?String(error.code):'read_failed'});}
}

// ---- commands ---------------------------------------------------------------------------------------------------------
export async function execute(command,{binding,bucket,args={},now=()=>Date.now(),ctx={}}){
 const state=await readState(binding);
 const m=state.marker;
 if(state.version===null||state.version<46||!m.installed)throw new OperatorStop('marker_not_installed',3);
 if(command==='status'){
  const out={operation:'status',writes:false,writeState:'none',state:view(state),pending:{receipts:state.pendingReceipts,diaryLinkIntents:state.diaryLinkIntents},c2:{ratedActive:ratedScopeActive(state),scopes:state.scopes.map(({scope,activated,enabled})=>({scope,activated,enabled}))},h1RulesEmpty:state.h1RulesEmpty};
  if(bucket){const frozen=await frozenPlan(bucket);out.r2=planView(frozen);out.blockers=blockers(frozen,state);}
  return out;
 }
 if(command==='parity'){
  if(!bucket)throw new OperatorStop('configuration',2);
  const frozen=await frozenPlan(bucket);
  if(!frozen.plan.manifest)throw new OperatorStop('plan_blocked',3,{blocked:frozen.plan.blocked.map(item=>({reason:item.reason}))});
  const parity=await parityOf(binding,frozen.plan,bucket);
  const stops=blockers(frozen,state);
  return {operation:'parity',writes:false,writeState:'none',state:view(state),equal:parity.equal,differences:parity.differences.map(item=>({kind:item.kind})),blockers:stops,r2:planView(frozen)};
 }
 if(!WRITES.includes(command))throw new OperatorStop('usage',2);
 if(m.generation!==args.generation)throw new OperatorStop('generation_moved',3,{marker:m});
 if(state.ratings?.mode!=='d1'||state.ratings?.cutover!=='open')throw new OperatorStop('ratings_not_open',3,{ratings:state.ratings});
 if(command==='close'||command==='reopen'){
  if(m.mode!==TRANSITIONS[command].from)throw new OperatorStop('marker_not_'+TRANSITIONS[command].from,3,{marker:m});
  const plan=transitionStatements(command,{generation:m.generation});
  const after=await applyBatch(binding,plan,ctx,plan.target,{unchangedState:m});
  return {operation:command,writes:true,writeState:'committed',before:view(state),marker:plan.target,after:view(after)};
 }
 if(command==='rollback-import'){
  if(m.mode==='d1')throw new OperatorStop('rollback_after_flip',3);
  if(ctx.track)ctx.track('unknown');
  try{await rollbackImport({DB:binding});}catch(error){if(ctx.track)ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{reason:error&&error.code?String(error.code):'rollback_failed'});}
  const after=await readState(binding);
  if(ctx.track)ctx.track('committed');
  return {operation:command,writes:true,writeState:'committed',before:view(state),after:view(after)};
 }
 // import and flip need the frozen cohort and its digest pin
 if(!bucket)throw new OperatorStop('configuration',2);
 if(m.mode!=='closed')throw new OperatorStop('marker_not_closed',3,{marker:m});
 const frozen=await frozenPlan(bucket);
 const stops=blockers(frozen,state);
 if(!frozen.plan.manifest||stops.length)throw new OperatorStop('no_go',3,{blockers:stops,r2:planView(frozen)});
 if(frozen.plan.manifestSha256!==args.manifestSha256)throw new OperatorStop('manifest_pin_mismatch',3,{r2:planView(frozen)});
 if(command==='import'){
  if(ctx.track)ctx.track('unknown');
  let result;
  try{result=await importDocuments({DB:binding},frozen.plan);}
  catch(error){throw new OperatorStop(error&&error.code==='diverged'?'diverged':'write_uncertain',3,{reason:error&&error.code?String(error.code):'import_failed',...(error&&error.detail&&error.detail.key?{kind:'document'}:{})});}
  const parity=await parityOf(binding,frozen.plan,bucket);
  if(!parity.equal)throw new OperatorStop('parity_mismatch',3,{differences:parity.differences.map(item=>({kind:item.kind}))});
  if(ctx.track)ctx.track('committed');
  return {operation:'import',writes:true,writeState:'committed',imported:result.imported,skipped:result.skipped,manifest:result.manifest,parity:'equal',r2:planView(frozen)};
 }
 // flip
 if(!ratedScopeActive(state))throw new OperatorStop('c2_not_active',3,{scopes:state.scopes.map(({scope,activated,enabled})=>({scope,activated,enabled}))});
 if(!state.h1RulesEmpty)throw new OperatorStop('h1_rules_not_empty',3);
 const parity=await parityOf(binding,frozen.plan,bucket);
 if(!parity.equal)throw new OperatorStop('parity_mismatch',3,{differences:parity.differences.map(item=>({kind:item.kind}))});
 const plan=flipStatements({generation:m.generation,activatedAt:new Date(now()).toISOString()});
 const after=await applyBatch(binding,plan,ctx,plan.target,{unchangedState:m});
 return {operation:'flip',writes:true,writeState:'committed',before:view(state),marker:plan.target,after:view(after),irreversible:true,r2:planView(frozen)};
}

// ---- CLI --------------------------------------------------------------------------------------------------------------
export function parseArgs(argv){
 const args=argv.slice(2),parsed={};
 const commands=args.filter(arg=>arg.startsWith('--')&&COMMANDS.includes(arg.slice(2)));
 if(commands.length>1)throw new OperatorStop('usage',2);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  const name=VALUE_FLAGS[arg],next=args[index+1];
  if(!name||next===undefined||next.startsWith('--')||parsed[name]!==undefined)throw new OperatorStop('usage',2);
  parsed[name]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(!WRITES.includes(command)){if(parsed.confirm!==undefined||Object.keys(parsed).some(key=>key!=='target'))throw new OperatorStop('usage',2);return {command,args:{}};}
 if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 for(const need of NEEDS[command])if(parsed[need]===undefined)throw new OperatorStop('usage',2);
 const out={};
 if(!/^\d{1,9}$/.test(parsed.generation))throw new OperatorStop('usage',2);
 out.generation=Number(parsed.generation);
 if(parsed.manifestSha256!==undefined){
  if(!NEEDS[command].includes('manifestSha256')||!/^[0-9a-f]{64}$/.test(parsed.manifestSha256))throw new OperatorStop('usage',2);
  out.manifestSha256=parsed.manifestSha256;
 }
 return {command,args:out};
}

function readStoreOf(env,fetchImpl){
 let credentials;
 try{credentials=readCredentials(env);}catch(error){throw normalize(error);}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 return createS3Store({credentials,fetchImpl});
}
// The S3 store already answers `get` with {etag, text()} and `list` with the complete listing (`truncated` false); the importer only reads through `list` and `get`.
export function bucketOf(store){return {list:options=>store.list(options),get:key=>store.get(key)};}

export async function runLetterboxdAdmissionCutover({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,bucket=null,target=null;
  if(deps)({binding,bucket=null}=deps);
  else{
   target=productionTarget(env);
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command!=='close'&&parsed.command!=='reopen'&&parsed.command!=='rollback-import')bucket=bucketOf(readStoreOf(env,fetchImpl));
   if(WRITES.includes(parsed.command))ctx.bookmark=await readBookmark(target,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,bucket,args:parsed.args,now,ctx:{track}});
  let bookmarkAfter=null;
  if(result.writes&&target)try{bookmarkAfter=await readBookmark(target,fetchImpl);}catch{bookmarkAfter=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(bookmarkAfter?{bookmarkAfter}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runLetterboxdAdmissionCutover();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
