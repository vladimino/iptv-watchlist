#!/usr/bin/env node
// Owner-only operator of the Predictions auxiliary-state cutover (ADR 0194, ADR 0196, AIR-554 Phase A). DORMANT: nothing here is authorized by merging it. Each command that writes needs its own bounded owner
// GO (the L3 plan of the card), the production database identity is pinned, and the default is a read-only `status`. It changes ONLY the aux domain: the tables of migrations/0034 and nothing else (no R2,
// no flag, no Scheduled Task, no Access, no other authority marker). Modeled on the verified 0033 operator (scripts/letterboxd-sync-control-production.mjs).
//
//   status    read-only: target, schema version, aux tables present, the marker (mode, generation), the exact row counts of the four families, the live runner lease, the other domains' mode/cutover;
//             with --sql-file also the sizing of an import file against the measured D1 batch limits. Never writes.
//   apply     schema 33 and none of the 0034 objects -> ONE atomic D1 batch of migrations/0034 (pinned by --migration-sha256), then an independent readback (schema 34, marker r2 at generation 0, empty tables).
//   close     marker r2 at exactly --generation G, empty aux tables -> marker closed at G+1 (admission of every legacy writer refused by the Worker, ADR 0196). Prints the generation N the import must name.
//   import    marker closed at exactly --generation N, empty aux tables -> the importer's guarded SQL (--sql-file, pinned by --sql-sha256, first statement pinned to N) as ONE atomic batch. A file over the measured
//             D1 batch limits is REFUSED with the numbers (import_too_large): no chunking is attempted; a resumable import would be its own reviewed contract.
//   verify    marker closed at N -> the importer's verification SQL (--sql-file, --sql-sha256): aborts on any difference between the rows and the export. Idempotent (it only moves the aux fence row).
//   flip      marker closed at N, the D1 counts equal to the importer's report (--report), the R2 listing identity (key, ETag, size) immediately before the flip equal to the one at the close
//             (--listing-before, --listing-now: identity.json of the converter), and a RELEASE the owner passes after reading it: without --release the command refuses and prints the exact release string,
//             which binds N, the listing identity and the verified counts. Then marker d1 at N+1 in ONE guarded batch. Irreversible: d1 is one-way.
//   reopen    marker closed at N and the aux tables still EMPTY -> marker r2 at N+1. Refused once an import exists (the tables refuse delete: that is an owner restore, never this command).
//
// Every write command needs `--target iptv --confirm <command>`. An unknown outcome is read back and reported as write_uncertain: NEVER retried. A refusal before any statement is sent changes nothing.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {BATCH_BYTES,BATCH_STATEMENTS,createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {AUX_TABLES,auxFlipRefusal} from '../src/prediction-aux-d1.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0034_prediction_aux_authority.sql');
export const COMMANDS=['status','apply','close','import','verify','flip','reopen'];
const FAMILY_TABLES=['prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
const sha256=value=>createHash('sha256').update(value).digest('hex');
async function one(binding,sql,...params){return (await binding.prepare(sql).bind(...params).first())??null;}
async function many(binding,sql,...params){return (await binding.prepare(sql).bind(...params).all()).results||[];}

export const migrationText=()=>fs.readFileSync(MIGRATION_PATH,'utf8');
export const migrationSha256=()=>sha256(migrationText());
export function migrationSql(){
 const statements=migrationStatements(migrationText());
 if(!statements.length||statements.some(sql=>/\bCOMMIT\b|\bDROP\s+TABLE\b|\bATTACH\b/i.test(sql)))throw new OperatorStop('migration_refused',3);
 return statements;
}

// ---- State: only what this operator needs; the other domains are compared by mode and cutover, never by their counters (a live generation counter is not a stop condition) ----
export async function readState(binding,now=Date.now()){
 try{
  const version=Number((await one(binding,'SELECT version FROM schema_contract WHERE id=1'))?.version);
  const names=new Set((await many(binding,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name));
  const present=AUX_TABLES.filter(name=>names.has(name));
  const state={schemaVersion:Number.isFinite(version)?version:null,tables:present.length,installed:present.length===AUX_TABLES.length,partial:present.length>0&&present.length<AUX_TABLES.length,marker:null,counts:null,outboxByState:null,predictionDomain:null,runnerLeaseLive:null,invariants:{}};
  if(state.installed){
   const marker=await one(binding,'SELECT mode, generation, activated_at FROM prediction_aux_authority WHERE id=1');
   state.marker=marker?{mode:marker.mode,generation:Number(marker.generation),activatedAt:marker.activated_at??null}:null;
   const counts=await one(binding,'SELECT (SELECT COUNT(*) FROM prediction_batch_stage) AS stage, (SELECT COUNT(*) FROM prediction_run_source_head) AS sources, (SELECT COUNT(*) FROM prediction_run_source_revision) AS revisions, (SELECT COUNT(*) FROM prediction_run_manifest) AS manifests, (SELECT COUNT(*) FROM prediction_run_manifest_piece) AS pieces, (SELECT COUNT(*) FROM prediction_event_outbox) AS outbox');
   state.counts=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)]));
   state.outboxByState=Object.fromEntries((await many(binding,'SELECT state, COUNT(*) AS n FROM prediction_event_outbox GROUP BY state ORDER BY state')).map(row=>[row.state,Number(row.n)]));
  }
  if(names.has('prediction_domain_authority'))state.predictionDomain=(await one(binding,'SELECT mode FROM prediction_domain_authority WHERE id=1'))?.mode??null;
  if(names.has('prediction_lease')){const lease=await one(binding,"SELECT expires_at FROM prediction_lease WHERE name='runner'");state.runnerLeaseLive=lease?Number(lease.expires_at)>now:false;}
  for(const table of [...names].filter(name=>/_authority$/.test(name)&&name!=='prediction_aux_authority').sort()){
   let row=null;
   try{row=await one(binding,'SELECT mode, cutover FROM '+table+' LIMIT 1');}catch{try{row=await one(binding,'SELECT mode FROM '+table+' LIMIT 1');}catch{row=null;}}
   if(row)state.invariants[table]={mode:row.mode??null,cutover:row.cutover??null};
  }
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}
const empty=state=>Boolean(state.counts)&&Object.values(state.counts).every(value=>value===0);
const markerIs=(state,mode,generation)=>state.installed&&state.marker?.mode===mode&&state.marker?.generation===generation;
const changedInvariants=(before,after)=>[...new Set([...Object.keys(before.invariants),...Object.keys(after.invariants)])].filter(name=>JSON.stringify(before.invariants[name]??null)!==JSON.stringify(after.invariants[name]??null)).sort();
export const view=state=>state?({schemaVersion:state.schemaVersion,tables:state.tables+'/'+AUX_TABLES.length,marker:state.marker,counts:state.counts,outboxByState:state.outboxByState,predictionDomain:state.predictionDomain,runnerLeaseLive:state.runnerLeaseLive}):null;

// ---- Decisions: each says what is allowed and why not; a refusal is a stop before any statement is sent ----
export function applyDecision(state){
 if(state.partial)return 'partial_schema';
 if(state.installed)return state.schemaVersion===34?'already_applied':'schema_unexpected';
 if(state.schemaVersion!==33)return 'schema_unexpected';
 if(state.predictionDomain!=='d1')return 'prediction_domain_not_d1';
 return 'apply';
}
function precondition(state,mode,generation){
 if(!state.installed)return 'aux_not_installed';
 if(state.marker?.mode!==mode)return 'marker_is_'+(state.marker?.mode??'missing');
 if(state.marker.generation!==generation)return 'generation_mismatch';
 return null;
}
export function closeDecision(state,{generation}){return precondition(state,'r2',generation)||(empty(state)?'close':'tables_not_empty');}
export function importDecision(state,{generation}){return precondition(state,'closed',generation)||(empty(state)?'import':'tables_not_empty');}
export function verifyDecision(state,{generation}){return precondition(state,'closed',generation)||'verify';}
export function reopenDecision(state,{generation}){return precondition(state,'closed',generation)||(empty(state)?'reopen':'tables_not_empty');}
export const expectedCounts=report=>({stage:report?.stage?.items,sources:report?.sources?.runs,revisions:report?.sources?.revisions,manifests:report?.manifests?.count,pieces:report?.manifests?.pieces,outbox:report?.outbox?.total});
// The release the owner passes to flip: it binds the closure generation, the listing identity of the moment and the verified counts, so it cannot be reused for another state.
export function flipRelease({generation,listingNow,report}){
 const identity=JSON.stringify([...listingNow].map(({key,etag,size})=>({key,etag,size})).sort((a,b)=>a.key<b.key?-1:1));
 return sha256('air554-flip|'+generation+'|'+sha256(identity)+'|'+sha256(JSON.stringify([expectedCounts(report),report?.outbox?.byState??{}]))).slice(0,16);
}
export function flipDecision(state,{generation,report,listingBefore,listingNow,release}){
 const bad=precondition(state,'closed',generation);if(bad)return {reason:bad};
 const want=expectedCounts(report);
 if(Object.values(want).some(value=>!Number.isSafeInteger(value)))return {reason:'report_invalid'};
 const differ=Object.keys(want).filter(key=>state.counts[key]!==want[key]);
 if(differ.length)return {reason:'counts_differ',details:{differ}};
 const byState=report.outbox.byState||{};
 const states=[...new Set([...Object.keys(byState),...Object.keys(state.outboxByState||{})])].filter(name=>(state.outboxByState?.[name]??0)!==(byState[name]??0));
 if(states.length)return {reason:'outbox_states_differ',details:{states}};
 let refusal;try{refusal=auxFlipRefusal(listingBefore,listingNow);}catch{return {reason:'listing_invalid'};}
 if(refusal)return {reason:'listing_changed',details:refusal};
 const expected=flipRelease({generation,listingNow,report});
 if(release===undefined)return {reason:'release_required',details:{release:expected}};
 if(release!==expected)return {reason:'release_mismatch'};
 return {reason:null,release:expected};
}

// ---- SQL the operator accepts from a file: the importer's own guarded SQL and nothing that could touch another domain ----
const ALLOWED_TARGET=new RegExp('^(?:INSERT\\s+INTO|UPDATE)\\s+('+AUX_TABLES.join('|')+')\\b','i');
export function importFile(text,{generation,pin,expectGuard,limits={}}){
 if(sha256(text)!==pin)throw new OperatorStop('sql_sha256_mismatch',3);
 const statements=migrationStatements(text);
 if(!statements.length)throw new OperatorStop('sql_empty',3);
 for(const sql of statements)if(!ALLOWED_TARGET.test(sql.trimStart()))throw new OperatorStop('sql_refused',3,{reason:'a statement outside the auxiliary tables'});
 if(expectGuard&&!new RegExp("^UPDATE prediction_aux_cas SET ok=\\(SELECT count\\(\\*\\) FROM prediction_aux_authority WHERE id=1 AND mode='closed' AND generation="+generation+"\\)").test(statements[0].trimStart()))throw new OperatorStop('sql_generation_mismatch',3,{expected:generation});
 const bytes=statements.reduce((sum,sql)=>sum+Buffer.byteLength(sql,'utf8'),0);
 const maxStatements=limits.statements??BATCH_STATEMENTS,maxBytes=limits.bytes??BATCH_BYTES;
 return {statements,sizing:{statements:statements.length,bytes,maxStatementBytes:Math.max(...statements.map(sql=>Buffer.byteLength(sql,'utf8'))),maxStatements,maxBytes,fits:statements.length<=maxStatements&&bytes<=maxBytes}};
}

async function write(binding,statements,{ctx,untouched}){
 ctx.track?.('unknown');
 try{await binding.batch(statements);}
 catch(error){
  // Nothing was sent when the binding itself refused (a batch over its limits): that is not an uncertain write.
  if(error instanceof OperatorStop){ctx.track?.('none');throw error;}
  let after=null;try{after=await readState(binding);}catch{after=null;}
  // Only a PROVEN statement rejection from the D1 API, with the state read back unchanged, may end as "not applied". A lost response, a timeout or an unproven receipt stays write_uncertain: never retried.
  const clean=error instanceof D1Error&&error.kind==='statement'&&Boolean(after)&&untouched(after);
  ctx.track?.(clean?'none':'unknown');
  throw new OperatorStop(clean?'statement_failed':'write_uncertain',3,{state:view(after)});
 }
}
const readback=async(binding,ctx)=>{try{return await readState(binding);}catch{ctx.track?.('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}};
function mismatch(ctx,problems,after){ctx.track?.('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,state:view(after)});}

export async function execute(command,{binding,now,ctx={},params={},limits={}}){
 const clock=typeof now==='function'?now():now;
 const state=await readState(binding,clock);
 const track=ctx.track?ctx:{};
 if(command==='status'){
  const out={operation:'status',writes:false,writeState:'none',migrationSha256:migrationSha256(),decisions:{apply:applyDecision(state)},...view(state),otherDomains:state.invariants};
  if(state.installed&&state.marker){const g=state.marker.generation;out.decisions={...out.decisions,close:closeDecision(state,{generation:g}),import:importDecision(state,{generation:g}),reopen:reopenDecision(state,{generation:g})};}
  if(params.sqlText!==undefined){
   try{out.importFile={sha256:sha256(params.sqlText),...importFile(params.sqlText,{generation:params.generation,pin:sha256(params.sqlText),expectGuard:Number.isSafeInteger(params.generation),limits}).sizing};}
   catch(error){if(error instanceof OperatorStop)out.importFile={sha256:sha256(params.sqlText),refused:error.reason,...(error.details||{})};else throw error;}
  }
  return out;
 }
 const before=state;
 if(command==='apply'){
  if(params.migrationSha256!==migrationSha256())throw new OperatorStop('migration_sha256_mismatch',3);
  const decision=applyDecision(state);if(decision!=='apply')throw new OperatorStop(decision,3);
  await write(binding,migrationSql().map(sql=>binding.prepare(sql).bind()),{ctx:track,untouched:after=>after.schemaVersion===33&&after.tables===0});
  const after=await readback(binding,track),problems=[];
  if(after.schemaVersion!==34)problems.push('schema_version');
  if(!markerIs(after,'r2',0))problems.push('marker');
  if(!empty(after))problems.push('rows_written');
  changedInvariants(before,after).forEach(name=>problems.push('mode_changed:'+name));
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:'apply',writes:true,writeState:'committed',migrationSha256:migrationSha256(),before:view(before),after:view(after)};
 }
 if(command==='close'||command==='reopen'){
  const generation=params.generation;
  const decision=(command==='close'?closeDecision:reopenDecision)(state,{generation});
  if(decision!==command)throw new OperatorStop(decision,3);
  const target=command==='close'?'closed':'r2',from=command==='close'?'r2':'closed';
  const statements=[
   binding.prepare("UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_aux_authority WHERE id=1 AND mode=? AND generation=?)*"+FAMILY_TABLES.map(table=>'(SELECT count(*)=0 FROM '+table+')').join('*')+' WHERE id=1').bind(from,generation),
   binding.prepare('UPDATE prediction_aux_authority SET mode=?, generation=? WHERE id=1 AND mode=? AND generation=?').bind(target,generation+1,from,generation),
  ];
  await write(binding,statements,{ctx:track,untouched:after=>markerIs(after,from,generation)});
  const after=await readback(binding,track),problems=[];
  if(!markerIs(after,target,generation+1))problems.push('marker');
  if(!empty(after))problems.push('rows_written');
  changedInvariants(before,after).forEach(name=>problems.push('mode_changed:'+name));
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:command,writes:true,writeState:'committed',generation:after.marker.generation,...(command==='close'?{importGeneration:after.marker.generation,next:'import and verify must name this generation'}:{}),before:view(before),after:view(after)};
 }
 if(command==='import'||command==='verify'){
  const generation=params.generation;
  const decision=(command==='import'?importDecision:verifyDecision)(state,{generation});
  if(decision!==command)throw new OperatorStop(decision,3);
  const file=importFile(params.sqlText??'',{generation,pin:params.sqlSha256,expectGuard:command==='import',limits});
  if(!file.sizing.fits)throw new OperatorStop('import_too_large',3,{...file.sizing,note:'no chunking is attempted; a resumable import is a separate reviewed contract'});
  await write(binding,file.statements.map(sql=>binding.prepare(sql).bind()),{ctx:track,untouched:after=>command==='import'?empty(after):true});
  const after=await readback(binding,track),problems=[];
  if(!markerIs(after,'closed',generation))problems.push('marker');
  if(command==='import'&&empty(after))problems.push('nothing_imported');
  changedInvariants(before,after).forEach(name=>problems.push('mode_changed:'+name));
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:command,writes:true,writeState:'committed',sqlSha256:params.sqlSha256,statements:file.sizing.statements,bytes:file.sizing.bytes,before:view(before),after:view(after)};
 }
 if(command==='flip'){
  const generation=params.generation;
  const decision=flipDecision(state,{generation,report:params.report,listingBefore:params.listingBefore,listingNow:params.listingNow,release:params.release});
  if(decision.reason)throw new OperatorStop(decision.reason,3,decision.details||{});
  const want=expectedCounts(params.report);
  const activatedAt=new Date(clock).toISOString();
  const guard=binding.prepare("UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_aux_authority WHERE id=1 AND mode='closed' AND generation=?)*"+['stage','sources','revisions','manifests','pieces','outbox'].map((key,index)=>'(SELECT count(*)=? FROM '+FAMILY_TABLES[index]+')').join('*')+' WHERE id=1').bind(generation,want.stage,want.sources,want.revisions,want.manifests,want.pieces,want.outbox);
  const flip=binding.prepare("UPDATE prediction_aux_authority SET mode='d1', generation=?, activated_at=? WHERE id=1 AND mode='closed' AND generation=?").bind(generation+1,activatedAt,generation);
  await write(binding,[guard,flip],{ctx:track,untouched:after=>markerIs(after,'closed',generation)});
  const after=await readback(binding,track),problems=[];
  if(!markerIs(after,'d1',generation+1)||after.marker.activatedAt!==activatedAt)problems.push('marker');
  for(const key of Object.keys(want))if(after.counts[key]!==want[key])problems.push('counts_changed:'+key);
  changedInvariants(before,after).forEach(name=>problems.push('mode_changed:'+name));
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:'flip',writes:true,writeState:'committed',irreversible:true,release:decision.release,before:view(before),after:view(after)};
 }
 throw new OperatorStop('usage',2);
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------
const OPTIONS={'--target':'target','--confirm':'confirm','--generation':'generation','--migration-sha256':'migrationSha256','--sql-file':'sqlFile','--sql-sha256':'sqlSha256','--report':'report','--listing-before':'listingBefore','--listing-now':'listingNow','--release':'release'};
const REQUIRED={status:[],apply:['migrationSha256'],close:['generation'],reopen:['generation'],import:['generation','sqlFile','sqlSha256'],verify:['generation','sqlFile','sqlSha256'],flip:['generation','report','listingBefore','listingNow']};
const ALLOWED={status:['sqlFile','generation'],apply:['migrationSha256'],close:['generation'],reopen:['generation'],import:['generation','sqlFile','sqlSha256'],verify:['generation','sqlFile','sqlSha256'],flip:['generation','report','listingBefore','listingNow','release']};
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
 if(command==='status'){if(parsed.confirm!==undefined)throw new OperatorStop('usage',2);}
 else if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 for(const name of Object.keys(parsed))if(name!=='target'&&name!=='confirm'&&!ALLOWED[command].includes(name))throw new OperatorStop('usage',2);
 for(const name of REQUIRED[command])if(parsed[name]===undefined)throw new OperatorStop('usage',2);
 if(parsed.generation!==undefined){
  // The marker starts at generation 0 (r2); every later state is 1 or more. The decisions refuse a generation the marker does not hold.
  if(!/^(0|[1-9]\d{0,8})$/.test(parsed.generation))throw new OperatorStop('usage',2);
  parsed.generation=Number(parsed.generation);
 }
 for(const name of ['migrationSha256','sqlSha256'])if(parsed[name]!==undefined&&!/^[0-9a-f]{64}$/.test(parsed[name]))throw new OperatorStop('usage',2);
 return {command,params:parsed};
}
function loadParams(params){
 const out={...params};
 const read=(file)=>{try{return fs.readFileSync(path.resolve(file),'utf8');}catch{throw new OperatorStop('file_unreadable',2);}};
 const json=(file)=>{try{return JSON.parse(read(file));}catch(error){if(error instanceof OperatorStop)throw error;throw new OperatorStop('file_invalid',2);}};
 if(out.sqlFile!==undefined)out.sqlText=read(out.sqlFile);
 if(out.report!==undefined)out.report=json(out.report);
 if(out.listingBefore!==undefined)out.listingBefore=json(out.listingBefore);
 if(out.listingNow!==undefined)out.listingNow=json(out.listingNow);
 return out;
}

export async function runPredictionAuxCutoverProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null,limits={}}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  const params=loadParams(parsed.params);
  let binding,adapterTarget=null;
  if(deps)({binding}=deps);
  else{
   adapterTarget=productionTarget(env);
   const adapter=trackProductionWrites(createD1Adapter({target:adapterTarget,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command!=='status')ctx.bookmark=await readBookmark(adapterTarget,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,now,ctx:{track},params,limits});
  let after=null;
  if(parsed.command!=='status'&&adapterTarget)try{after=await readBookmark(adapterTarget,fetchImpl);}catch{after=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(after?{bookmarkAfter:after}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runPredictionAuxCutoverProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
