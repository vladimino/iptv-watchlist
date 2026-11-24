#!/usr/bin/env node
// Owner-only operator of the Predictions auxiliary-state cutover (ADR 0194, ADR 0196, AIR-554 Phase A). DORMANT: nothing here is authorized by merging it. Each command that writes needs its own bounded owner
// GO (the L3 plan of the card), the production database identity is pinned, and the default is a read-only `status`. It changes ONLY the aux domain: the tables of migrations/0034 and nothing else (no R2,
// no flag, no Scheduled Task, no Access, no other authority marker). Modeled on the verified 0033 operator (scripts/letterboxd-sync-control-production.mjs).
//
//   status    read-only: target, schema version, aux and receipt tables present, the marker (mode, generation), the exact row counts of the four families, the receipts of the closure generation (import chunks, seal,
//             verification slices), the live runner lease, the other domains' mode/cutover; with --converted <dir> (and --generation N) also the PLAN DIGEST (the pin of every chunked step) and the chunks and slices the
//             operator DERIVES from that converted tree, with their sizes against the budgets. Never writes.
//   apply     schema 33 and none of the 0034 objects -> ONE atomic D1 batch of migrations/0034 and 0035; schema 34 (0034 applied, 0035 not) -> 0035 only; pinned by --migration-sha256 (covers both files); then an
//             independent readback (schema 35, marker r2 at generation 0, empty tables, empty receipt tables).
//   close     marker r2 at exactly --generation G, empty aux tables -> marker closed at G+1 (admission of every legacy writer refused by the Worker, ADR 0196). Prints the generation N the import must name.
//   import    marker closed at exactly --generation N -> the ordered import CHUNKS of whole runs (ADR 0202), each ONE atomic batch with an in-transaction guard and its own receipt; resumes from the receipts; an
//             ambiguous outcome is read back and only the SAME chunk is sent again (exactly-once by its guard); never replaced by other bytes. --max-chunks N stops after N chunks (a run is resumable).
//   seal      marker closed at N, every import receipt present -> the SEAL: a trigger on every auxiliary data table then refuses writes until the marker is d1.
//   verify    marker closed at N, sealed -> the canonical byte-level verification as receipted SLICES on the sealed data; resumes from the receipts.
//   flip      marker closed at N, sealed, every chunk and slice receipt of the plan present, the D1 counts and outbox states equal to the report DERIVED from the converted tree (--capture-before: the converted output
//             taken at the close); --capture-now: a fresh cut just before the flip; the same proof kind, two distinct cuts, the last one fresh, equal (key, ETag, size) identity; and a RELEASE the owner passes after reading
//             it (without --release the command refuses and prints it; it binds N, the final capture, the counts and digests, the plan digest and the receipt counts). ONE small atomic batch moves the marker to d1.
//             Irreversible: d1 is one-way.
//   reopen    marker closed at N and the aux tables still EMPTY -> marker r2 at N+1. Refused once a chunk exists (the tables refuse delete: that is an owner restore, never this command).
//
// The SQL is never read from a file: the importer derives every statement from the converted tree after each of its objects was re-hashed against the capture's identity; the pin is the plan digest `status` prints.
// Every write command needs `--target iptv --confirm <command>`. An unknown outcome is read back and reported as write_uncertain: NEVER retried. A refusal before any statement is sent changes nothing.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {BATCH_BYTES,BATCH_STATEMENTS,PRODUCTION_ACCOUNT_ID,createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {AUX_TABLES,auxFlipRefusal} from '../src/prediction-aux-d1.js';
import {WHOLE_STORE_SCOPE,PREDICTION_AUX_SCOPE,scopeDigest} from './prediction-aux-scope.mjs';
import {CHUNK_LIMITS,buildPlan,chunkPlan,flipStatements,planReport,planSha256,readExport,sealStatements,slicePlan} from './prediction-aux-d1-import.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const MIGRATION_PATH=path.join(ROOT,'migrations/0034_prediction_aux_authority.sql');
// Migration 0035 (ADR 0202): the import receipts, the seal and the seal triggers. Additive; 0034 is unchanged and stays the first file.
export const RECEIPTS_MIGRATION_PATH=path.join(ROOT,'migrations/0035_prediction_aux_import_receipts.sql');
export const COMMANDS=['status','apply','close','import','seal','verify','flip','reopen'];
export const RECEIPT_TABLES=['prediction_aux_import_chunk','prediction_aux_seal','prediction_aux_verify_slice'];
const FAMILY_TABLES=['prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
const sha256=value=>createHash('sha256').update(value).digest('hex');
async function one(binding,sql,...params){return (await binding.prepare(sql).bind(...params).first())??null;}
async function many(binding,sql,...params){return (await binding.prepare(sql).bind(...params).all()).results||[];}
// A statement whose text is final (every value is an inline literal) must reach D1 verbatim. The published REST binding renders `?` as a placeholder ANYWHERE in the text, a string literal of the data included,
// so the first real chunk (a source text with a question mark in it) failed with "Missing SQL parameter" on 24 Nov 2026 before anything was sent. `verbatim` hands such a statement over as it is; a binding without it
// (the test stand-in) keeps `prepare(sql).bind()`.
const verbatim=(binding,sql)=>typeof binding.verbatim==='function'?binding.verbatim(sql):binding.prepare(sql).bind();
export function restBinding(adapter){
 const published=createPublishedBinding(adapter);
 return {prepare:sql=>published.prepare(sql),batch:statements=>published.batch(statements),verbatim:sql=>({text:String(sql)})};
}

export const migrationText=()=>fs.readFileSync(MIGRATION_PATH,'utf8');
export const receiptsMigrationText=()=>fs.readFileSync(RECEIPTS_MIGRATION_PATH,'utf8');
// The pin of `apply` covers both files, in order.
export const migrationSha256=()=>sha256(sha256(migrationText())+'|'+sha256(receiptsMigrationText()));
function statementsOf(text){
 const statements=migrationStatements(text);
 if(!statements.length||statements.some(sql=>/\bCOMMIT\b|\bDROP\s+TABLE\b|\bATTACH\b/i.test(sql)))throw new OperatorStop('migration_refused',3);
 return statements;
}
// `parts`: which files a database still needs. Schema 33 needs 0034 and 0035 in ONE atomic batch; schema 34 (0034 applied, 0035 not) needs 0035 only.
export function migrationSql(parts=['0034','0035']){
 return [...(parts.includes('0034')?statementsOf(migrationText()):[]),...(parts.includes('0035')?statementsOf(receiptsMigrationText()):[])];
}

// ---- State: only what this operator needs; the other domains are compared by mode and cutover, never by their counters (a live generation counter is not a stop condition) ----
export async function readState(binding,now=Date.now()){
 try{
  const version=Number((await one(binding,'SELECT version FROM schema_contract WHERE id=1'))?.version);
  const names=new Set((await many(binding,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name));
  const present=AUX_TABLES.filter(name=>names.has(name));
  const state={schemaVersion:Number.isFinite(version)?version:null,tables:present.length,installed:present.length===AUX_TABLES.length,partial:present.length>0&&present.length<AUX_TABLES.length,marker:null,counts:null,outboxByState:null,predictionDomain:null,runnerLeaseLive:null,invariants:{},receiptTables:0,receipts:false,partialReceipts:false,chunks:[],seals:[],slices:[]};
  if(state.installed){
   const marker=await one(binding,'SELECT mode, generation, activated_at FROM prediction_aux_authority WHERE id=1');
   state.marker=marker?{mode:marker.mode,generation:Number(marker.generation),activatedAt:marker.activated_at??null}:null;
   const counts=await one(binding,'SELECT (SELECT COUNT(*) FROM prediction_batch_stage) AS stage, (SELECT COUNT(*) FROM prediction_run_source_head) AS sources, (SELECT COUNT(*) FROM prediction_run_source_revision) AS revisions, (SELECT COUNT(*) FROM prediction_run_manifest) AS manifests, (SELECT COUNT(*) FROM prediction_run_manifest_piece) AS pieces, (SELECT COUNT(*) FROM prediction_event_outbox) AS outbox');
   state.counts=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)]));
   state.outboxByState=Object.fromEntries((await many(binding,'SELECT state, COUNT(*) AS n FROM prediction_event_outbox GROUP BY state ORDER BY state')).map(row=>[row.state,Number(row.n)]));
  }
  // Migration 0035 (ADR 0202): the receipts of the chunked import, the seal and the receipts of the verification slices.
  const receiptPresent=RECEIPT_TABLES.filter(name=>names.has(name));
  state.receiptTables=receiptPresent.length;state.receipts=receiptPresent.length===RECEIPT_TABLES.length;state.partialReceipts=receiptPresent.length>0&&!state.receipts;
  if(state.installed&&state.receipts){
   state.chunks=(await many(binding,'SELECT generation, chunk_no, chunk_sha256, plan_sha256, statements, bytes FROM prediction_aux_import_chunk ORDER BY generation, chunk_no')).map(row=>({generation:Number(row.generation),chunkNo:Number(row.chunk_no),chunkSha256:row.chunk_sha256,planSha256:row.plan_sha256,statements:Number(row.statements),bytes:Number(row.bytes)}));
   state.seals=(await many(binding,'SELECT generation, plan_sha256, chunk_count, slice_count FROM prediction_aux_seal ORDER BY generation')).map(row=>({generation:Number(row.generation),planSha256:row.plan_sha256,chunkCount:Number(row.chunk_count),sliceCount:Number(row.slice_count)}));
   state.slices=(await many(binding,'SELECT generation, slice_no, slice_sha256, plan_sha256 FROM prediction_aux_verify_slice ORDER BY generation, slice_no')).map(row=>({generation:Number(row.generation),sliceNo:Number(row.slice_no),sliceSha256:row.slice_sha256,planSha256:row.plan_sha256}));
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
export const view=state=>state?({schemaVersion:state.schemaVersion,tables:state.tables+'/'+AUX_TABLES.length,receiptTables:state.receiptTables+'/'+RECEIPT_TABLES.length,marker:state.marker,counts:state.counts,outboxByState:state.outboxByState,predictionDomain:state.predictionDomain,runnerLeaseLive:state.runnerLeaseLive,receipts:state.installed&&state.receipts?{chunks:state.chunks.length,seals:state.seals.length,slices:state.slices.length}:null}):null;
// The receipts of the closure generation the marker holds.
const receiptsOf=(state,generation)=>({chunks:state.chunks.filter(item=>item.generation===generation),seal:state.seals.find(item=>item.generation===generation)??null,slices:state.slices.filter(item=>item.generation===generation)});

// ---- Decisions: each says what is allowed and why not; a refusal is a stop before any statement is sent ----
export function applyDecision(state){
 if(state.partial||state.partialReceipts||(!state.installed&&state.receiptTables>0))return 'partial_schema';
 if(state.installed&&state.receipts)return state.schemaVersion===35?'already_applied':'schema_unexpected';
 // 0034 applied, 0035 not: only the receipts migration is missing.
 if(state.installed)return state.schemaVersion===34?'apply':'schema_unexpected';
 if(state.schemaVersion!==33)return 'schema_unexpected';
 if(state.predictionDomain!=='d1')return 'prediction_domain_not_d1';
 return 'apply';
}
function precondition(state,mode,generation){
 if(!state.installed)return 'aux_not_installed';
 if(!state.receipts)return 'receipts_not_installed';
 if(state.marker?.mode!==mode)return 'marker_is_'+(state.marker?.mode??'missing');
 if(state.marker.generation!==generation)return 'generation_mismatch';
 return null;
}
export function closeDecision(state,{generation}){return precondition(state,'r2',generation)||(empty(state)?'close':'tables_not_empty');}
export function reopenDecision(state,{generation}){return precondition(state,'closed',generation)||(empty(state)?'reopen':'tables_not_empty');}
// A receipt must be exactly the planned chunk or slice of the same plan: a mismatch is a stop (a receipt of another plan, another closure or other bytes is never resumed over).
function receiptsMatch(received,planned,keyNo,keySha,planSha){
 for(let index=0;index<received.length;index++){
  if(index>=planned.length)return 'receipts_exceed_plan';
  if(received[index].planSha256!==planSha)return 'receipt_plan_mismatch';
  if(received[index][keyNo]!==index+1||received[index][keySha]!==planned[index][keySha])return 'receipt_mismatch';
 }
 return null;
}
export function importDecision(state,{generation,chunking}){
 const bad=precondition(state,'closed',generation);if(bad)return bad;
 const r=receiptsOf(state,generation);
 if(r.seal)return 'sealed';
 if(chunking){
  const mismatch=receiptsMatch(r.chunks,chunking.chunks,'chunkNo','chunkSha256',chunking.planSha256);if(mismatch)return mismatch;
  if(r.chunks.length===chunking.chunkCount)return 'import_complete';
 }
 if(r.chunks.length===0&&!empty(state))return 'tables_not_empty';
 return 'import';
}
export function sealDecision(state,{generation,chunking,slicing,report}){
 const bad=precondition(state,'closed',generation);if(bad)return bad;
 const r=receiptsOf(state,generation);
 if(r.seal)return 'already_sealed';
 const mismatch=receiptsMatch(r.chunks,chunking.chunks,'chunkNo','chunkSha256',chunking.planSha256);if(mismatch)return mismatch;
 if(r.chunks.length!==chunking.chunkCount)return 'import_incomplete';
 const want=expectedCounts(report),differ=Object.keys(want).filter(key=>state.counts[key]!==want[key]);
 if(differ.length)return 'counts_differ';
 if(!Number.isSafeInteger(slicing.sliceCount))return 'slices_unplanned';
 return 'seal';
}
const sealMatches=(seal,{chunking,slicing})=>seal&&seal.planSha256===chunking.planSha256&&seal.chunkCount===chunking.chunkCount&&seal.sliceCount===slicing.sliceCount;
export function verifyDecision(state,{generation,chunking,slicing}){
 const bad=precondition(state,'closed',generation);if(bad)return bad;
 const r=receiptsOf(state,generation);
 if(!r.seal)return 'not_sealed';
 if(!sealMatches(r.seal,{chunking,slicing}))return 'seal_mismatch';
 const mismatch=receiptsMatch(r.slices,slicing.slices,'sliceNo','sliceSha256',chunking.planSha256);if(mismatch)return mismatch;
 return r.slices.length===slicing.sliceCount?'verify_complete':'verify';
}
export const expectedCounts=report=>({stage:report?.stage?.items,sources:report?.sources?.runs,revisions:report?.sources?.revisions,manifests:report?.manifests?.count,pieces:report?.manifests?.pieces,outbox:report?.outbox?.total});
const digestsOf=report=>[report?.stage?.digest??null,report?.sources?.digest??null,report?.manifests?.digest??null,report?.outbox?.digest??null];
export const DEFAULT_SOURCE={kind:'cloudflare-r2-s3',bucket:'iptv',accountId:PRODUCTION_ACCOUNT_ID};
export const MAX_CAPTURE_AGE_MS=15*60*1000;
// The consistency proof a capture carries: the whole bucket (a capture without a scope is the original whole-bucket cut) or the Predictions auxiliary scope, and nothing else. A digest that is not exactly the
// current definition of the scope it names is `null` (unsupported). The two captures of a flip must carry the same one (review of PR 912: a narrower scope changes the proof, so it travels with the capture).
export function captureScope(report){
 const scope=report?.snapshot?.scope;
 if(scope==null)return {kind:'full_bucket',digest:scopeDigest(WHOLE_STORE_SCOPE)};
 if(scope.kind==='full_bucket'&&(scope.digest==null||scope.digest===scopeDigest(WHOLE_STORE_SCOPE)))return {kind:'full_bucket',digest:scopeDigest(WHOLE_STORE_SCOPE)};
 if(scope.kind==='prediction_aux'&&scope.digest===scopeDigest(PREDICTION_AUX_SCOPE))return {kind:'prediction_aux',digest:scope.digest};
 return null;
}
// The release the owner passes to flip. It binds the closure generation, the proof kind, the listing identity of the final capture, the verified counts and digests of the report and the verification SQL, so it cannot be reused
// for another state, another export or another verification.
export function flipRelease({generation,capture,report,planSha256:plan,chunkCount,sliceCount}){
 return sha256(['air554-flip',generation,capture.identitySha256,captureScope(capture.report)?.digest??'',sha256(JSON.stringify([expectedCounts(report),report?.outbox?.byState??{},digestsOf(report)])),plan,chunkCount,sliceCount].join('|')).slice(0,16);
}
// A capture is the output directory of one converter run: identity.json (key, ETag, size) and converter-report.json (what was cut, where, when). Neither is trusted for its own sake: the identity must hash to
// the report's recorded digest, the cut must be a consistent fenced one from the expected source, and the two captures of a flip must be two distinct cuts, the last one fresh.
function captureProblem(capture,source){
 const report=capture?.report;
 if(!report||report.schemaVersion!==1||!Array.isArray(capture.identity)||typeof capture.identitySha256!=='string')return 'capture_invalid';
 if(report.snapshot?.status!=='consistent_fenced')return 'capture_not_consistent';
 if(!captureScope(report))return 'capture_scope_unsupported';
 const found=report.snapshot?.source||{};
 if(found.kind!==source.kind||found.bucket!==source.bucket||found.accountId!==source.accountId)return 'capture_source_mismatch';
 if(report.converted?.identitySha256!==capture.identitySha256)return 'capture_identity_mismatch';
 if(!Number.isFinite(Date.parse(report.snapshot?.finishedAt)))return 'capture_invalid';
 return null;
}
export function flipDecision(state,{generation,report,before,now,chunking,slicing,release,clock,source=DEFAULT_SOURCE,maxAgeMs=MAX_CAPTURE_AGE_MS}){
 const bad=precondition(state,'closed',generation);if(bad)return {reason:bad};
 const want=expectedCounts(report);
 if(Object.values(want).some(value=>!Number.isSafeInteger(value)))return {reason:'report_invalid'};
 // The cohort must be sealed under this plan and fully verified: every import receipt and every verification receipt of the plan, in order, and nothing else.
 const r=receiptsOf(state,generation);
 if(!r.seal)return {reason:'not_sealed'};
 if(!sealMatches(r.seal,{chunking,slicing}))return {reason:'seal_mismatch'};
 const chunkProblem=receiptsMatch(r.chunks,chunking.chunks,'chunkNo','chunkSha256',chunking.planSha256);
 if(chunkProblem||r.chunks.length!==chunking.chunkCount)return {reason:chunkProblem||'import_incomplete'};
 const sliceProblem=receiptsMatch(r.slices,slicing.slices,'sliceNo','sliceSha256',chunking.planSha256);
 if(sliceProblem||r.slices.length!==slicing.sliceCount)return {reason:sliceProblem||'verify_incomplete'};
 const differ=Object.keys(want).filter(key=>state.counts[key]!==want[key]);
 if(differ.length)return {reason:'counts_differ',details:{differ}};
 const byState=report.outbox.byState||{};
 const states=[...new Set([...Object.keys(byState),...Object.keys(state.outboxByState||{})])].filter(name=>(state.outboxByState?.[name]??0)!==(byState[name]??0));
 if(states.length)return {reason:'outbox_states_differ',details:{states}};
 for(const [name,capture] of [['before',before],['now',now]]){const problem=captureProblem(capture,source);if(problem)return {reason:problem,details:{capture:name}};}
 const scopeBefore=captureScope(before.report),scopeNow=captureScope(now.report);
 if(scopeBefore.kind!==scopeNow.kind||scopeBefore.digest!==scopeNow.digest)return {reason:'capture_scope_mismatch',details:{before:scopeBefore.kind,now:scopeNow.kind}};
 // The report must come from the export the captures describe: the objects of each family it counts are the objects the converter copied.
 const families=before.report.converted?.families||{};
 const fromExport={sources:families.source?.objects??0,manifests:families.manifest?.objects??0,outbox:families.event?.objects??0};
 if(want.sources!==fromExport.sources||want.manifests!==fromExport.manifests||want.outbox!==fromExport.outbox)return {reason:'report_not_from_export',details:{report:{sources:want.sources,manifests:want.manifests,outbox:want.outbox},export:fromExport}};
 const finishedBefore=Date.parse(before.report.snapshot.finishedAt),finishedNow=Date.parse(now.report.snapshot.finishedAt);
 if(!(finishedNow>finishedBefore))return {reason:'captures_not_distinct'};
 if(!(clock>=finishedNow)||clock-finishedNow>maxAgeMs)return {reason:'capture_not_fresh',details:{ageMs:clock-finishedNow,maxAgeMs}};
 let refusal;try{refusal=auxFlipRefusal(before.identity,now.identity);}catch{return {reason:'listing_invalid'};}
 if(refusal)return {reason:'listing_changed',details:refusal};
 const expected=flipRelease({generation,capture:now,report,planSha256:chunking.planSha256,chunkCount:chunking.chunkCount,sliceCount:slicing.sliceCount});
 if(release===undefined)return {reason:'release_required',details:{release:expected}};
 if(release!==expected)return {reason:'release_mismatch'};
 return {reason:null,release:expected};
}

// ---- The statements of every batch are DERIVED by the importer from the verified converted tree (never read from a file); here each batch is re-checked against the exact SHAPES the importer prints. ----
// Review of PR 897: a prefix check let `UPDATE prediction_aux_authority SET mode='d1' ...` through a caller's file and would have activated the irreversible state without --flip and without the owner's release.
// No batch except the flip may name the marker, and the flip's marker statement is one exact shape: string literals are masked first, then every statement must be a guard, a data insert, a verification assertion or
// the receipt of its own batch.
const DATA_TABLES=['prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
const stripLiterals=statement=>statement.replace(/'(?:[^']|'')*'/g,'?');
const VALUE='(?:\\?|-?\\d+|NULL)';
const INSERT_SHAPE=new RegExp('^INSERT INTO ('+DATA_TABLES.join('|')+') \\([a-z_, ]+\\) VALUES \\('+VALUE+'(?:, ?'+VALUE+')*\\);?$');
const HEAD_SHAPE=/^UPDATE prediction_batch_stage_head SET item_count=\d+, total_bytes=\d+, revision=1, updated_at=(?:\?|NULL) WHERE id=1 AND revision=0;?$/;
const CONDITION='[a-z_]+(?:=| IS )'+VALUE;
const ROW_VERIFY=new RegExp('^UPDATE prediction_aux_cas SET ok=\\(SELECT count\\(\\*\\)=(\\d+) FROM ('+DATA_TABLES.join('|')+')(?: WHERE '+CONDITION+'(?: AND '+CONDITION+')*)?\\) WHERE id=1;?$');
// The stage head the Worker cross-checks against the rows (count, aggregate bytes, revision, updated_at): one exact assertion.
const HEAD_VERIFY=/^UPDATE prediction_aux_cas SET ok=\(SELECT count\(\*\)=1 FROM prediction_batch_stage_head WHERE id=1 AND item_count=\d+ AND total_bytes=\d+ AND revision=[01] AND updated_at IS (?:\?|NULL)\) WHERE id=1;?$/;
const VERIFY_SHAPE={test:text=>ROW_VERIFY.test(text)||HEAD_VERIFY.test(text)};
const receiptShape=table=>new RegExp('^INSERT INTO '+table+' \\([a-z_0-9, ]+\\) VALUES \\('+VALUE+'(?:, ?'+VALUE+')*\\);?$');
const CHUNK_RECEIPT=receiptShape('prediction_aux_import_chunk'),SLICE_RECEIPT=receiptShape('prediction_aux_verify_slice'),SEAL_ROW=receiptShape('prediction_aux_seal');
// tested on the text as printed (not the masked one): the modes and the time are fixed literals
const MARKER_FLIP=/^UPDATE prediction_aux_authority SET mode='d1', generation=\d+, activated_at='\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z' WHERE id=1 AND mode='closed' AND generation=\d+$/;
// A guard sets the fence row only: one UPDATE, read-only subqueries, no write verb anywhere else.
const isGuard=statement=>{const masked=stripLiterals(statement);return statement.startsWith('UPDATE prediction_aux_cas SET ok=')&&statement.endsWith(' WHERE id=1')&&(masked.match(/\bUPDATE\b/g)||[]).length===1&&!/\b(INSERT|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH)\b/i.test(masked)&&!/prediction_aux_authority SET/.test(masked)&&!masked.includes(';');};
export function checkBatch(kind,statements,limits={}){
 if(!Array.isArray(statements)||!statements.length)throw new OperatorStop('sql_empty',3);
 const refuse=(index,reason)=>{throw new OperatorStop('sql_refused',3,{reason,statement:index});};
 if(!isGuard(statements[0]))refuse(0,'the first statement is not a guard');
 const last=statements.length-1,masked=statements.map(stripLiterals);
 if(kind==='chunk'){
  if(statements.length<3||!CHUNK_RECEIPT.test(masked[last]))refuse(last,'the last statement is not the chunk receipt');
  for(let index=1;index<last;index++)if(!INSERT_SHAPE.test(masked[index])&&!HEAD_SHAPE.test(masked[index]))refuse(index,'a statement that is not an importer insert or stage head update');
 }else if(kind==='slice'){
  if(statements.length<3||!SLICE_RECEIPT.test(masked[last]))refuse(last,'the last statement is not the slice receipt');
  for(let index=1;index<last;index++)if(!VERIFY_SHAPE.test(masked[index]))refuse(index,'a statement that is not an importer verification assertion');
 }else if(kind==='seal'){
  if(statements.length!==2||!SEAL_ROW.test(masked[1]))refuse(1,'the second statement is not the seal row');
 }else if(kind==='flip'){
  if(statements.length!==2||!MARKER_FLIP.test(statements[1]))refuse(1,'the second statement is not the marker flip');
 }else throw new OperatorStop('usage',2);
 const bytes=statements.reduce((sum,sql)=>sum+Buffer.byteLength(sql,'utf8'),0);
 const maxStatements=limits.statements??BATCH_STATEMENTS,maxBytes=limits.bytes??BATCH_BYTES;
 return {statements:statements.length,bytes,maxStatementBytes:Math.max(...statements.map(sql=>Buffer.byteLength(sql,'utf8'))),maxStatements,maxBytes,fits:statements.length<=maxStatements&&bytes<=maxBytes};
}

async function write(binding,statements,{ctx,untouched}){
 ctx.track?.('unknown');
 try{await binding.batch(statements);}
 catch(error){
  // Nothing was sent when the binding itself refused (a batch over its limits): that is not an uncertain write.
  if(error instanceof OperatorStop){ctx.track?.('none');throw error;}
  let after=null;try{after=await readState(binding);}catch{after=null;}
  // Only a PROVEN statement rejection from the D1 API, with the state read back unchanged, may end as "not applied". A lost response, a timeout or an unproven receipt stays write_uncertain.
  const clean=error instanceof D1Error&&error.kind==='statement'&&Boolean(after)&&untouched(after);
  ctx.track?.(clean?'none':'unknown');
  throw new OperatorStop(clean?'statement_failed':'write_uncertain',3,{state:view(after)});
 }
}
const readback=async(binding,ctx)=>{try{return await readState(binding);}catch{ctx.track?.('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_unreadable'});}};
function mismatch(ctx,problems,after){ctx.track?.('unknown');throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,state:view(after)});}

// The budgets of a chunk or a slice: the owner's starting design limit (1,500 statements, 6 MiB), never above the measured D1 batch limits.
const batchBudget=limits=>({statements:Math.min(limits.statements??CHUNK_LIMITS.statements,BATCH_STATEMENTS),bytes:Math.min(limits.bytes??CHUNK_LIMITS.bytes,BATCH_BYTES)});
// Everything the chunked steps need, derived from the converted tree: the plan digest (the pin), the ordered import chunks and the ordered verification slices of ONE closure generation.
export function plansOf(converted,generation,limits={}){
 const budget=batchBudget(limits);
 // The decisions refuse a generation the marker does not hold before any batch is sent; the planning itself only needs a closure generation (1 or more).
 const planned=Math.max(1,generation);
 try{
  const chunking=chunkPlan(converted.plan,{generation:planned,limits:budget});
  const slicing=slicePlan(converted.plan,{generation:planned,chunkCount:chunking.chunkCount,limits:budget});
  return {budget,chunking,slicing};
 }catch(error){
  if(error?.blocker)throw new OperatorStop('chunk_unit_over_limits',3,{statements:error.unitStatements??null,bytes:error.unitBytes??null,limits:budget,note:'a whole run (or one outbox row) does not fit one batch: no splitting of a run is attempted'});
  throw error;
 }
}
const pinned=(params,plans)=>{if(params.planSha256!==plans.chunking.planSha256)throw new OperatorStop('plan_sha256_mismatch',3);};
export const sizingOf=items=>({batches:items.length,statements:items.reduce((n,x)=>n+x.statements,0),bytes:items.reduce((n,x)=>n+x.bytes,0),maxBatchStatements:Math.max(0,...items.map(x=>x.statements)),maxBatchBytes:Math.max(0,...items.map(x=>x.bytes))});
const nowMs=()=>Number(process.hrtime.bigint()/1000000n);

// One receipted batch (an import chunk or a verification slice), sent with the ambiguity rule of ADR 0202: the batch is exactly-once by its in-transaction guard and its unique receipt, so after any
// failure the receipts are READ, and a receipt of exactly these bytes means it was applied (by this attempt or an earlier one); a missing receipt proves nothing, and the SAME batch (same bytes) may be sent again,
// at most `attempts` times. Another receipt in its place, or a state that cannot be read, is a stop.
async function sendReceipted(binding,item,{generation,no,sha,field,list,ctx,attempts=3}){
 const receiptOf=state=>list(receiptsOf(state,generation)).find(row=>row[field.no]===no)??null;
 const countOf=state=>list(receiptsOf(state,generation)).length;
 for(let attempt=1;;attempt++){
  try{
   await write(binding,item.sql.map(sql=>verbatim(binding,sql)),{ctx,untouched:after=>countOf(after)===no-1});
   return {applied:'this_attempt',attempts:attempt};
  }catch(error){
   if(!(error instanceof OperatorStop)||!['write_uncertain','statement_failed'].includes(error.reason))throw error;
   let after=null;try{after=await readState(binding);}catch{after=null;}
   if(!after)throw error;
   const found=receiptOf(after);
   if(found){
    if(found[field.sha]!==sha)throw new OperatorStop('receipt_mismatch',3,{no});
    ctx.track?.('committed');
    return {applied:'earlier_attempt',attempts:attempt};
   }
   if(error.reason==='statement_failed'||attempt>=attempts)throw error;
   ctx.track?.('unknown');
  }
 }
}

export async function execute(command,{binding,now,ctx={},params={},limits={}}){
 const clock=typeof now==='function'?now():now;
 let state=await readState(binding,clock);
 const track=ctx.track?ctx:{};
 const before=state;
 const verifyUnchangedDomains=(after,problems)=>changedInvariants(before,after).forEach(name=>problems.push('mode_changed:'+name));
 if(command==='status'){
  const out={operation:'status',writes:false,writeState:'none',migrationSha256:migrationSha256(),decisions:{apply:applyDecision(state)},...view(state),otherDomains:state.invariants};
  if(state.installed&&state.receipts&&state.marker){const g=state.marker.generation;out.decisions={...out.decisions,close:closeDecision(state,{generation:g}),reopen:reopenDecision(state,{generation:g})};}
  if(params.converted){
   // What the owner reads BEFORE a write command: the report, the plan digest (the pin of every chunked step) and the derived chunks and slices, with their sizes against the budgets.
   const c=params.converted,planSha=planSha256(c.plan);
   out.converted={tree:c.directory,report:{stage:c.report.stage,sources:c.report.sources,manifests:c.report.manifests,outbox:c.report.outbox},identitySha256:c.capture.identitySha256,planSha256:planSha};
   if(Number.isSafeInteger(params.generation)){
    try{
     const plans=plansOf(c,params.generation,limits);
     const imports=plans.chunking.chunks.map(x=>checkBatch('chunk',x.sql,plans.budget)),slices=plans.slicing.slices.map(x=>checkBatch('slice',x.sql,plans.budget));
     out.converted.generation=params.generation;
     out.converted.budget=plans.budget;
     out.converted.import={chunks:plans.chunking.chunkCount,...sizingOf(imports),fits:imports.every(x=>x.fits)};
     out.converted.verify={slices:plans.slicing.sliceCount,...sizingOf(slices),fits:slices.every(x=>x.fits)};
     out.converted.batches={import:plans.chunking.chunkCount,seal:1,verify:plans.slicing.sliceCount,flip:1,total:plans.chunking.chunkCount+plans.slicing.sliceCount+2};
     if(state.installed&&state.receipts&&state.marker&&state.marker.generation===params.generation){
      out.decisions.import=importDecision(state,{generation:params.generation,chunking:plans.chunking});
      out.decisions.seal=sealDecision(state,{generation:params.generation,chunking:plans.chunking,slicing:plans.slicing,report:c.report});
      out.decisions.verify=verifyDecision(state,{generation:params.generation,chunking:plans.chunking,slicing:plans.slicing});
     }
    }catch(error){if(error instanceof OperatorStop)out.converted.refused=error.reason;else throw error;}
   }
  }
  return out;
 }
 if(command==='apply'){
  if(params.migrationSha256!==migrationSha256())throw new OperatorStop('migration_sha256_mismatch',3);
  const decision=applyDecision(state);if(decision!=='apply')throw new OperatorStop(decision,3);
  const parts=state.installed?['0035']:['0034','0035'];
  const startVersion=state.installed?34:33;
  await write(binding,migrationSql(parts).map(sql=>verbatim(binding,sql)),{ctx:track,untouched:after=>after.schemaVersion===startVersion&&after.tables===(state.installed?AUX_TABLES.length:0)&&after.receiptTables===0});
  const after=await readback(binding,track),problems=[];
  if(after.schemaVersion!==35)problems.push('schema_version');
  if(!markerIs(after,'r2',0))problems.push('marker');
  if(!empty(after))problems.push('rows_written');
  if(!after.receipts||after.chunks.length||after.seals.length||after.slices.length)problems.push('receipts');
  verifyUnchangedDomains(after,problems);
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:'apply',writes:true,writeState:'committed',migrationSha256:migrationSha256(),applied:parts,before:view(before),after:view(after)};
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
  verifyUnchangedDomains(after,problems);
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:command,writes:true,writeState:'committed',generation:after.marker.generation,...(command==='close'?{importGeneration:after.marker.generation,next:'import, seal and verify must name this generation'}:{}),before:view(before),after:view(after)};
 }
 if(command==='import'||command==='verify'){
  const generation=params.generation;
  if(!params.converted)throw new OperatorStop('converted_required',2);
  const plans=plansOf(params.converted,generation,limits);pinned(params,plans);
  const isImport=command==='import';
  const items=isImport?plans.chunking.chunks:plans.slicing.slices;
  const decide=current=>isImport?importDecision(current,{generation,chunking:plans.chunking}):verifyDecision(current,{generation,chunking:plans.chunking,slicing:plans.slicing});
  const done=[],cap=params.maxChunks??Infinity;
  let current=state;
  for(;;){
   const decision=decide(current);
   if(decision===(isImport?'import_complete':'verify_complete'))break;
   if(decision!==command)throw new OperatorStop(decision,3);
   if(done.length>=cap)break;
   const received=isImport?receiptsOf(current,generation).chunks.length:receiptsOf(current,generation).slices.length;
   const item=items[received],no=received+1;
   checkBatch(isImport?'chunk':'slice',item.sql,plans.budget);
   const started=nowMs();
   const sent=await sendReceipted(binding,item,{generation,no,sha:isImport?item.chunkSha256:item.sliceSha256,field:isImport?{no:'chunkNo',sha:'chunkSha256'}:{no:'sliceNo',sha:'sliceSha256'},list:isImport?(r=>r.chunks):(r=>r.slices),ctx:track});
   const after=await readback(binding,track),problems=[];
   if(!markerIs(after,'closed',generation))problems.push('marker');
   const receipts=isImport?receiptsOf(after,generation).chunks:receiptsOf(after,generation).slices;
   if(receipts.length!==no||receipts[no-1][isImport?'chunkSha256':'sliceSha256']!==(isImport?item.chunkSha256:item.sliceSha256))problems.push('receipt');
   verifyUnchangedDomains(after,problems);
   if(problems.length)mismatch(track,problems,after);
   track.track?.('committed');
   done.push({no,statements:item.statements,bytes:item.bytes,ms:nowMs()-started,applied:sent.applied,attempts:sent.attempts});
   current=after;
  }
  const complete=decide(current)===(isImport?'import_complete':'verify_complete');
  return {operation:command,writes:done.length>0,writeState:done.length?'committed':'none',planSha256:plans.chunking.planSha256,generation,total:isImport?plans.chunking.chunkCount:plans.slicing.sliceCount,appliedNow:done,complete,next:complete?(isImport?'seal':'flip'):'run the same command again: it resumes from the receipts',before:view(before),after:view(current)};
 }
 if(command==='seal'){
  const generation=params.generation;
  if(!params.converted)throw new OperatorStop('converted_required',2);
  const plans=plansOf(params.converted,generation,limits);pinned(params,plans);
  const decision=sealDecision(state,{generation,chunking:plans.chunking,slicing:plans.slicing,report:params.converted.report});
  if(decision!=='seal')throw new OperatorStop(decision,3);
  const statements=sealStatements(params.converted.plan,{generation,chunkCount:plans.chunking.chunkCount,sliceCount:plans.slicing.sliceCount});
  checkBatch('seal',statements,plans.budget);
  await write(binding,statements.map(sql=>verbatim(binding,sql)),{ctx:track,untouched:after=>!receiptsOf(after,generation).seal});
  const after=await readback(binding,track),problems=[];
  const seal=receiptsOf(after,generation).seal;
  if(!markerIs(after,'closed',generation))problems.push('marker');
  if(!sealMatches(seal,{chunking:plans.chunking,slicing:plans.slicing}))problems.push('seal');
  verifyUnchangedDomains(after,problems);
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:'seal',writes:true,writeState:'committed',planSha256:plans.chunking.planSha256,generation,chunks:plans.chunking.chunkCount,slices:plans.slicing.sliceCount,next:'verify',before:view(before),after:view(after)};
 }
 if(command==='flip'){
  const generation=params.generation;
  // The dataset, the report, the chunks and the slices are all derived from the converted tree of the capture taken at the close (its files were checked against that capture's identity when it was loaded).
  const converted=params.captureBefore;
  if(!converted?.plan||!converted?.report)throw new OperatorStop('converted_required',2);
  const plans=plansOf(converted,generation,limits);pinned(params,plans);
  const decision=flipDecision(state,{generation,report:converted.report,before:converted.capture,now:params.captureNow,chunking:plans.chunking,slicing:plans.slicing,release:params.release,clock,source:params.source,maxAgeMs:params.maxCaptureAgeMs});
  if(decision.reason)throw new OperatorStop(decision.reason,3,decision.details||{});
  const activatedAt=new Date(clock).toISOString();
  const statements=flipStatements(converted.plan,{generation,chunkCount:plans.chunking.chunkCount,sliceCount:plans.slicing.sliceCount,activatedAt});
  checkBatch('flip',statements,plans.budget);
  // ONE small atomic batch: the guard (marker, seal, receipts 1 to K and slices 1 to M of the one plan digest, totals, outbox states) and the marker move to d1.
  await write(binding,statements.map(sql=>verbatim(binding,sql)),{ctx:track,untouched:after=>markerIs(after,'closed',generation)});
  const after=await readback(binding,track),problems=[];
  const want=expectedCounts(converted.report);
  if(!markerIs(after,'d1',generation+1)||after.marker.activatedAt!==activatedAt)problems.push('marker');
  for(const key of Object.keys(want))if(after.counts[key]!==want[key])problems.push('counts_changed:'+key);
  verifyUnchangedDomains(after,problems);
  if(problems.length)mismatch(track,problems,after);
  track.track?.('committed');
  return {operation:'flip',writes:true,writeState:'committed',irreversible:true,release:decision.release,planSha256:plans.chunking.planSha256,receipts:{chunks:plans.chunking.chunkCount,slices:plans.slicing.sliceCount},before:view(before),after:view(after)};
 }
 throw new OperatorStop('usage',2);
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------
const OPTIONS={'--target':'target','--confirm':'confirm','--generation':'generation','--migration-sha256':'migrationSha256','--converted':'converted','--plan-sha256':'planSha256','--max-chunks':'maxChunks','--capture-before':'captureBefore','--capture-now':'captureNow','--release':'release'};
const REQUIRED={status:[],apply:['migrationSha256'],close:['generation'],reopen:['generation'],import:['generation','converted','planSha256'],seal:['generation','converted','planSha256'],verify:['generation','converted','planSha256'],flip:['generation','captureBefore','captureNow','planSha256']};
const ALLOWED={status:['converted','generation'],apply:['migrationSha256'],close:['generation'],reopen:['generation'],import:['generation','converted','planSha256','maxChunks'],seal:['generation','converted','planSha256'],verify:['generation','converted','planSha256','maxChunks'],flip:['generation','captureBefore','captureNow','planSha256','release']};
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
 for(const name of ['migrationSha256','planSha256'])if(parsed[name]!==undefined&&!/^[0-9a-f]{64}$/.test(parsed[name]))throw new OperatorStop('usage',2);
 if(parsed.maxChunks!==undefined){if(!/^[1-9]\d{0,5}$/.test(parsed.maxChunks))throw new OperatorStop('usage',2);parsed.maxChunks=Number(parsed.maxChunks);}
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
 return {directory,capture,plan,report,planSha256:planSha256(plan)};
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
   binding=restBinding(adapter);
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
