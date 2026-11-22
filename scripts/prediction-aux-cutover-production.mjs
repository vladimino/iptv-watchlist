#!/usr/bin/env node
// Owner-only operator of the Predictions auxiliary-state cutover (ADR 0194, ADR 0196, AIR-554 Phase A). DORMANT: nothing here is authorized by merging it. Each command that writes needs its own bounded owner
// GO (the L3 plan of the card), the production database identity is pinned, and the default is a read-only `status`. It changes ONLY the aux domain: the tables of migrations/0034 and nothing else (no R2,
// no flag, no Scheduled Task, no Access, no other authority marker). Modeled on the verified 0033 operator (scripts/letterboxd-sync-control-production.mjs).
//
//   status    read-only: target, schema version, aux tables present, the marker (mode, generation), the exact row counts of the four families, the live runner lease, the other domains' mode/cutover;
//             with --converted <dir> also the SQL the operator DERIVES from that converted tree (pins, statement count, bytes against the measured D1 batch limits). Never writes.
//   apply     schema 33 and none of the 0034 objects -> ONE atomic D1 batch of migrations/0034 (pinned by --migration-sha256), then an independent readback (schema 34, marker r2 at generation 0, empty tables).
//   close     marker r2 at exactly --generation G, empty aux tables -> marker closed at G+1 (admission of every legacy writer refused by the Worker, ADR 0196). Prints the generation N the import must name.
//   import    marker closed at exactly --generation N, empty aux tables -> the importer's guarded SQL as ONE atomic batch. The SQL is NEVER read from a file: it is derived from --converted (a converter
//             output directory whose tree objects are re-hashed against its own identity.json) and pinned by --sql-sha256 (the hash `status` printed). Statement shapes are re-checked (the guard for N first,
//             then exact insert or stage-head forms; anything touching the marker is refused). Over the measured D1 batch limits: REFUSED with the numbers (import_too_large), no chunking.
//   verify    marker closed at N -> the importer's canonical row-level verification (planVerifySql) derived from --converted, pinned by --sql-sha256. Idempotent.
//   flip      marker closed at N; D1 counts and outbox states equal the report DERIVED from the converted tree (--capture-before: the converted output taken at the close); the canonical verification
//             (pinned by --verify-sql-sha256) executed INSIDE the same atomic batch as the marker update (a differing byte aborts the batch before the marker moves); --capture-now: a fresh cut just before
//             the flip; same expected source, two distinct cuts, the last one fresh, equal (key, ETag, size) identity; and a RELEASE the owner passes after reading it (without --release the command
//             refuses and prints it; it binds N, the final capture, the counts and digests and the verification SQL). Then marker d1 at N+1. Irreversible: d1 is one-way.
//   reopen    marker closed at N and the aux tables still EMPTY -> marker r2 at N+1. Refused once an import exists (the tables refuse delete: that is an owner restore, never this command).
//
// Every write command needs `--target iptv --confirm <command>`. An unknown outcome is read back and reported as write_uncertain: NEVER retried. A refusal before any statement is sent changes nothing.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {BATCH_BYTES,BATCH_STATEMENTS,PRODUCTION_ACCOUNT_ID,createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {AUX_TABLES,auxFlipRefusal} from '../src/prediction-aux-d1.js';
import {buildPlan,importGuardStatement,planReport,planSql,planVerifySql,readExport} from './prediction-aux-d1-import.mjs';

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
// What the importer's report must say for each table the verification asserts a total for.
const reportTotals=report=>({prediction_batch_stage:report?.stage?.items,prediction_run_source_head:report?.sources?.runs,prediction_run_source_revision:report?.sources?.revisions,prediction_run_manifest:report?.manifests?.count,prediction_run_manifest_piece:report?.manifests?.pieces,prediction_event_outbox:report?.outbox?.total});
const digestsOf=report=>[report?.stage?.digest??null,report?.sources?.digest??null,report?.manifests?.digest??null,report?.outbox?.digest??null];
export const DEFAULT_SOURCE={kind:'cloudflare-r2-s3',bucket:'iptv',accountId:PRODUCTION_ACCOUNT_ID};
export const MAX_CAPTURE_AGE_MS=15*60*1000;
// The release the owner passes to flip. It binds the closure generation, the listing identity of the final capture, the verified counts and digests of the report and the verification SQL, so it cannot be reused
// for another state, another export or another verification.
export function flipRelease({generation,capture,report,verifySha256}){
 return sha256(['air554-flip',generation,capture.identitySha256,sha256(JSON.stringify([expectedCounts(report),report?.outbox?.byState??{},digestsOf(report)])),verifySha256].join('|')).slice(0,16);
}
// A capture is the output directory of one converter run: identity.json (key, ETag, size) and converter-report.json (what was cut, where, when). Neither is trusted for its own sake: the identity must hash to
// the report's recorded digest, the cut must be a consistent fenced one from the expected source, and the two captures of a flip must be two distinct cuts, the last one fresh.
function captureProblem(capture,source){
 const report=capture?.report;
 if(!report||report.schemaVersion!==1||!Array.isArray(capture.identity)||typeof capture.identitySha256!=='string')return 'capture_invalid';
 if(report.snapshot?.status!=='consistent_fenced')return 'capture_not_consistent';
 const found=report.snapshot?.source||{};
 if(found.kind!==source.kind||found.bucket!==source.bucket||found.accountId!==source.accountId)return 'capture_source_mismatch';
 if(report.converted?.identitySha256!==capture.identitySha256)return 'capture_identity_mismatch';
 if(!Number.isFinite(Date.parse(report.snapshot?.finishedAt)))return 'capture_invalid';
 return null;
}
export function flipDecision(state,{generation,report,before,now,verify,release,clock,source=DEFAULT_SOURCE,maxAgeMs=MAX_CAPTURE_AGE_MS}){
 const bad=precondition(state,'closed',generation);if(bad)return {reason:bad};
 const want=expectedCounts(report);
 if(Object.values(want).some(value=>!Number.isSafeInteger(value)))return {reason:'report_invalid'};
 const differ=Object.keys(want).filter(key=>state.counts[key]!==want[key]);
 if(differ.length)return {reason:'counts_differ',details:{differ}};
 const byState=report.outbox.byState||{};
 const states=[...new Set([...Object.keys(byState),...Object.keys(state.outboxByState||{})])].filter(name=>(state.outboxByState?.[name]??0)!==(byState[name]??0));
 if(states.length)return {reason:'outbox_states_differ',details:{states}};
 // The exact verification of the approved dataset travels INSIDE the flip batch, so it cannot be skipped; here it must be the verification of THIS report.
 if(!verify)return {reason:'verify_required'};
 const wantTotals=reportTotals(report),wrong=Object.keys(wantTotals).filter(table=>verify.totals[table]!==wantTotals[table]);
 if(wrong.length)return {reason:'verify_not_for_report',details:{tables:wrong}};
 for(const [name,capture] of [['before',before],['now',now]]){const problem=captureProblem(capture,source);if(problem)return {reason:problem,details:{capture:name}};}
 // The report must come from the export the captures describe: the objects of each family it counts are the objects the converter copied.
 const families=before.report.converted?.families||{};
 const fromExport={sources:families.source?.objects??0,manifests:families.manifest?.objects??0,outbox:families.event?.objects??0};
 if(want.sources!==fromExport.sources||want.manifests!==fromExport.manifests||want.outbox!==fromExport.outbox)return {reason:'report_not_from_export',details:{report:{sources:want.sources,manifests:want.manifests,outbox:want.outbox},export:fromExport}};
 const finishedBefore=Date.parse(before.report.snapshot.finishedAt),finishedNow=Date.parse(now.report.snapshot.finishedAt);
 if(!(finishedNow>finishedBefore))return {reason:'captures_not_distinct'};
 if(!(clock>=finishedNow)||clock-finishedNow>maxAgeMs)return {reason:'capture_not_fresh',details:{ageMs:clock-finishedNow,maxAgeMs}};
 let refusal;try{refusal=auxFlipRefusal(before.identity,now.identity);}catch{return {reason:'listing_invalid'};}
 if(refusal)return {reason:'listing_changed',details:refusal};
 const expected=flipRelease({generation,capture:now,report,verifySha256:verify.sha256});
 if(release===undefined)return {reason:'release_required',details:{release:expected}};
 if(release!==expected)return {reason:'release_mismatch'};
 return {reason:null,release:expected};
}

// ---- SQL the operator accepts from a file: the SHAPES the importer prints, nothing else. A hash the caller supplies is only a checksum; what protects the marker is that no statement may touch it. ----
// Review of PR 897: a prefix check (INSERT or UPDATE of an aux table) let `UPDATE prediction_aux_authority SET mode='d1' ...` through, which would have activated the irreversible state without --flip and
// without the owner's release. Every statement must now be one of the importer's exact forms (string literals masked first), and only the first statement of an import may name the marker, as the exact guard.
const DATA_TABLES=['prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
const stripLiterals=statement=>statement.replace(/'(?:[^']|'')*'/g,'?');
const VALUE='(?:\\?|-?\\d+|NULL)';
const INSERT_SHAPE=new RegExp('^INSERT INTO ('+DATA_TABLES.join('|')+') \\([a-z_, ]+\\) VALUES \\('+VALUE+'(?:, ?'+VALUE+')*\\)$');
const HEAD_SHAPE=/^UPDATE prediction_batch_stage_head SET item_count=\d+, total_bytes=\d+, revision=1, updated_at=(?:\?|NULL) WHERE id=1 AND revision=0$/;
const CONDITION='[a-z_]+(?:=| IS )'+VALUE;
const VERIFY_SHAPE=new RegExp('^UPDATE prediction_aux_cas SET ok=\\(SELECT count\\(\\*\\)=(\\d+) FROM ('+DATA_TABLES.join('|')+')(?: WHERE '+CONDITION+'(?: AND '+CONDITION+')*)?\\) WHERE id=1$');
const TOTAL_SHAPE=new RegExp('^UPDATE prediction_aux_cas SET ok=\\(SELECT count\\(\\*\\)=(\\d+) FROM ('+DATA_TABLES.join('|')+')\\) WHERE id=1$');
// kind 'import': the exact importer guard first, then inserts and the stage head only. kind 'verify': only the importer's read-back assertions. Returns the statements, the sizing and, for verify, the totals asserted.
export function checkedSql(text,{kind,generation,pin,limits={}}){
 if(typeof text!=='string'||!text.trim())throw new OperatorStop('sql_empty',3);
 if(sha256(text)!==pin)throw new OperatorStop('sql_sha256_mismatch',3);
 const statements=migrationStatements(text).map(sql=>sql.trim());
 if(!statements.length)throw new OperatorStop('sql_empty',3);
 const totals={};
 statements.forEach((sql,index)=>{
  if(kind==='import'&&index===0){
   // Not a guard at all: refused. A guard for another closure (or with any other text): a generation mismatch.
   if(!/^UPDATE prediction_aux_cas SET ok=\(SELECT count\(\*\) FROM prediction_aux_authority WHERE id=1 AND mode='closed' AND generation=\d+\)/.test(sql))throw new OperatorStop('sql_refused',3,{reason:'the first statement is not the importer guard',statement:0});
   const named=Number.isSafeInteger(generation)?generation:Number(/AND generation=(\d+)\)/.exec(sql)?.[1]);
   if(!Number.isSafeInteger(named)||sql!==importGuardStatement(named)||(Number.isSafeInteger(generation)&&named!==generation))throw new OperatorStop('sql_generation_mismatch',3,{expected:generation??null});
   return;
  }
  const masked=stripLiterals(sql);
  if(kind==='import'){
   if(!INSERT_SHAPE.test(masked)&&!HEAD_SHAPE.test(masked))throw new OperatorStop('sql_refused',3,{reason:'a statement that is not an importer insert or stage head update',statement:index});
   return;
  }
  const match=VERIFY_SHAPE.exec(masked);
  if(!match)throw new OperatorStop('sql_refused',3,{reason:'a statement that is not an importer verification assertion',statement:index});
  const total=TOTAL_SHAPE.exec(masked);
  if(total)totals[total[2]]=Number(total[1]);
 });
 const bytes=statements.reduce((sum,sql)=>sum+Buffer.byteLength(sql,'utf8'),0);
 const maxStatements=limits.statements??BATCH_STATEMENTS,maxBytes=limits.bytes??BATCH_BYTES;
 return {statements,totals,sha256:sha256(text),sizing:{statements:statements.length,bytes,maxStatementBytes:Math.max(...statements.map(sql=>Buffer.byteLength(sql,'utf8'))),maxStatements,maxBytes,fits:statements.length<=maxStatements&&bytes<=maxBytes}};
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
  if(params.converted){
   // What the owner reads BEFORE a write command: the report, the digests and the hashes of the SQL the operator will derive itself from this tree (the pins of `--import`, `--verify` and `--flip`).
   const c=params.converted,verifyText=planVerifySql(c.plan),verifySha=sha256(verifyText);
   out.converted={tree:c.directory,report:{stage:c.report.stage,sources:c.report.sources,manifests:c.report.manifests,outbox:c.report.outbox},identitySha256:c.capture.identitySha256,verifySha256:verifySha,verify:checkedSql(verifyText,{kind:'verify',pin:verifySha,limits}).sizing};
   if(Number.isSafeInteger(params.generation)){
    const text=planSql(c.plan,params.generation),pin=sha256(text);
    try{out.converted.import={generation:params.generation,sha256:pin,...checkedSql(text,{kind:'import',generation:params.generation,pin,limits}).sizing};}
    catch(error){if(error instanceof OperatorStop)out.converted.import={generation:params.generation,refused:error.reason};else throw error;}
   }
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
  if(!params.converted)throw new OperatorStop('converted_required',2);
  // The SQL is DERIVED from the converted tree (never read from a file the caller supplies); the pin is the owner's confirmation of what `status` printed for exactly this tree.
  const text=command==='import'?planSql(params.converted.plan,generation):planVerifySql(params.converted.plan);
  const file=checkedSql(text,{kind:command,generation,pin:params.sqlSha256,limits});
  if(!file.sizing.fits)throw new OperatorStop(command+'_too_large',3,{...file.sizing,note:'no chunking is attempted; a resumable import is a separate reviewed contract'});
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
  // The dataset, the report and the verification are all derived from the converted tree of the capture taken at the close (its files were checked against that capture's identity when it was loaded).
  const converted=params.captureBefore;
  if(!converted?.plan||!converted?.report)throw new OperatorStop('converted_required',2);
  const report=converted.report;
  const verify=checkedSql(planVerifySql(converted.plan),{kind:'verify',generation,pin:params.verifySha256,limits});
  if(verify.sizing.statements+2>verify.sizing.maxStatements||verify.sizing.bytes>verify.sizing.maxBytes)throw new OperatorStop('verify_too_large',3,{...verify.sizing,note:'the flip needs the whole verification in one batch with the marker update'});
  const decision=flipDecision(state,{generation,report,before:converted.capture,now:params.captureNow,verify,release:params.release,clock,source:params.source,maxAgeMs:params.maxCaptureAgeMs});
  if(decision.reason)throw new OperatorStop(decision.reason,3,decision.details||{});
  const want=expectedCounts(report);
  const activatedAt=new Date(clock).toISOString();
  const guard=binding.prepare("UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_aux_authority WHERE id=1 AND mode='closed' AND generation=?)*"+['stage','sources','revisions','manifests','pieces','outbox'].map((key,index)=>'(SELECT count(*)=? FROM '+FAMILY_TABLES[index]+')').join('*')+' WHERE id=1').bind(generation,want.stage,want.sources,want.revisions,want.manifests,want.pieces,want.outbox);
  const flip=binding.prepare("UPDATE prediction_aux_authority SET mode='d1', generation=?, activated_at=? WHERE id=1 AND mode='closed' AND generation=?").bind(generation+1,activatedAt,generation);
  // One atomic batch: the importer's exact verification of the approved dataset, the guard, then the flip. A byte of the imported rows that differs from the export aborts the whole batch before the marker moves.
  await write(binding,[...verify.statements.map(sql=>binding.prepare(sql).bind()),guard,flip],{ctx:track,untouched:after=>markerIs(after,'closed',generation)});
  const after=await readback(binding,track),problems=[];
  if(!markerIs(after,'d1',generation+1)||after.marker.activatedAt!==activatedAt)problems.push('marker');
  for(const key of Object.keys(want))if(after.counts[key]!==want[key])problems.push('counts_changed:'+key);
  changedInvariants(before,after).forEach(name=>problems.push('mode_changed:'+name));
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:'flip',writes:true,writeState:'committed',irreversible:true,release:decision.release,verifiedInBatch:{statements:verify.sizing.statements,sha256:verify.sha256},before:view(before),after:view(after)};
 }
 throw new OperatorStop('usage',2);
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------
const OPTIONS={'--target':'target','--confirm':'confirm','--generation':'generation','--migration-sha256':'migrationSha256','--converted':'converted','--sql-sha256':'sqlSha256','--capture-before':'captureBefore','--capture-now':'captureNow','--verify-sql-sha256':'verifySha256','--release':'release'};
const REQUIRED={status:[],apply:['migrationSha256'],close:['generation'],reopen:['generation'],import:['generation','converted','sqlSha256'],verify:['generation','converted','sqlSha256'],flip:['generation','captureBefore','captureNow','verifySha256']};
const ALLOWED={status:['converted','generation'],apply:['migrationSha256'],close:['generation'],reopen:['generation'],import:['generation','converted','sqlSha256'],verify:['generation','converted','sqlSha256'],flip:['generation','captureBefore','captureNow','verifySha256','release']};
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
 for(const name of ['migrationSha256','sqlSha256','verifySha256'])if(parsed[name]!==undefined&&!/^[0-9a-f]{64}$/.test(parsed[name]))throw new OperatorStop('usage',2);
 return {command,params:parsed};
}
// One converter output directory: identity.json (key, ETag, size, SHA-256 of each object) and converter-report.json.
export function readCapture(directory){
 const read=(file)=>{try{return fs.readFileSync(path.resolve(file),'utf8');}catch{throw new OperatorStop('file_unreadable',2);}};
 const json=(text)=>{try{return JSON.parse(text);}catch{throw new OperatorStop('file_invalid',2);}};
 const identityText=read(path.join(directory,'identity.json'));
 return {identity:json(identityText),identityText,identitySha256:sha256(identityText),report:json(read(path.join(directory,'converter-report.json')))};
}
const walk=(directory,base=directory)=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const full=path.join(directory,entry.name);return entry.isDirectory()?walk(full,base):[path.relative(base,full).split(path.sep).join('/')];});
// The dataset the import, the verification and the report are all DERIVED from. Review of PR 897: a verification SQL or a report supplied by the caller (with a hash the caller computes) proves nothing, so the
// operator takes none: it reads the converter's `tree/` itself, requires every file to be exactly the object the capture recorded (SHA-256 and size, no extra, no missing), builds the importer's own plan and
// derives the import SQL, the exact verification SQL and the report from it. A plan with a blocker is refused.
export async function loadConverted(directory){
 const capture=readCapture(directory);
 const tree=path.join(directory,'tree');
 let files;
 try{files=walk(tree);}catch{throw new OperatorStop('file_unreadable',2);}
 const recorded=new Map(capture.identity.map(item=>[item.key,item]));
 if(files.length!==recorded.size||files.some(key=>!recorded.has(key)))throw new OperatorStop('tree_not_from_capture',3,{reason:'the files of the tree are not the objects the capture recorded'});
 for(const [key,item] of recorded){
  const bytes=fs.readFileSync(path.join(tree,...key.split('/')));
  if(bytes.length!==item.size||sha256(bytes)!==item.sha256)throw new OperatorStop('tree_not_from_capture',3,{reason:'an object of the tree differs from the capture',keyDigest:sha256(key).slice(0,12)});
 }
 const plan=await buildPlan(readExport(tree));
 if(plan.blockers.length)throw new OperatorStop('converted_blocked',3,{blockers:plan.blockers.map(item=>item.code)});
 const report=await planReport(plan);
 return {directory,capture,plan,report,verifyText:planVerifySql(plan),importText:generation=>planSql(plan,generation)};
}
async function loadParams(params){
 const out={...params};
 if(out.converted!==undefined)out.converted=await loadConverted(out.converted);
 if(out.captureBefore!==undefined)out.captureBefore=await loadConverted(out.captureBefore);
 if(out.captureNow!==undefined)out.captureNow=readCapture(out.captureNow);
 return out;
}

export async function runPredictionAuxCutoverProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null,limits={}}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  const params=await loadParams(parsed.params);
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
