// AIR-374 H1 (docs/runbooks/film-person-h1-load-package.md): the OFFLINE operator verifier of the P5 load (scripts/film-person-prepared-loader.mjs). It touches no network, no D1, no R2, no Cloudflare and no
// connector, and it NEVER emits or runs a write: the batch SQL of the load stays an artifact of the loader's `sql` command and is sent only under the owner's separate GO. This tool (1) EMITS the exact read-only
// SELECT statements of the state check (the lease and window statements are the very ones of the 0019 preflight kit) and (2) VERIFIES what an authorized operator pasted back, refusing everything else with
// named reasons: the state before the lease (`verify-preflight`), with the run's own lease held (`verify-held`), after the last batch (`verify-readback`), after the release (`verify-released`), the summary the
// loader's `plan` printed (`verify-plan`), the batch list its `sql` printed (`verify-emitted`) and the D1 result of one sent batch (`verify-batch`).
// A pass is evidence, never permission: the owner's operation-specific GO is separate and nothing here is a GO.
//
//   node scripts/film-person-h1-verify.mjs state-sql                                      the read-only SELECT statements (all phases)
//   node scripts/film-person-h1-verify.mjs verify-preflight <results.json> --reference R [--now ISO]
//   node scripts/film-person-h1-verify.mjs verify-held <results.json> --reference R --lease-id ID [--now ISO]
//   node scripts/film-person-h1-verify.mjs verify-readback <results.json> --held <held.json> --reference R --lease-id ID --counts A,B,C [--now ISO]
//   node scripts/film-person-h1-verify.mjs verify-released <results.json> --held <held.json> --reference R --lease-id ID --counts A,B,C
//   node scripts/film-person-h1-verify.mjs verify-plan <plan.json> --plan-digest D --counts A,B,C --reference R --at ISO --verified-films-sha X --view-index-sha Y --retirements-sha Z
//   node scripts/film-person-h1-verify.mjs verify-emitted <sql-output.json> --plan-digest D --counts A,B,C [--batch-set-digest H]
//   node scripts/film-person-h1-verify.mjs verify-batch <response.json> --rows N
//   any verify command with --diagnostic: shape only, never a pass (ok is always false, diagnosticOnly true)
// Every verification FAILS CLOSED: the pinned values of the GO (reference, counts, digests, lease id) are mandatory; without them it refuses. Results files are {"<statement id>": <rows array | D1 envelope>}.
// Exit status 1 on a refusal.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReadOnly,unwrap} from './schema-preflight.mjs';
import {NOTE,RECEIPT_TABLES,preflightSteps as migrationSteps} from './film-person-0019-preflight.mjs';
import {BATCH_ROWS,CLASSES,EXPECTED,LOADER_VERSION,MAX_SOURCE_BYTES,RUN_BATCHES,RUN_STATEMENTS,SOURCE_KEYS,TABLES} from './film-person-prepared-loader.mjs';

export const SCHEMA_VERSION=19;
export const MARKER_GENERATION=1;
export const MIN_LEASE_REMAINING_MS=15*60000;
const REFERENCE=/^cutover_accepted\/v2:[0-9a-f]{64}$/;
const HEX64=/^[0-9a-f]{64}$/;
const LEASE_ID=/^[A-Za-z0-9:._-]{8,80}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTITY_TABLES=Object.freeze(['film_external_id','film_redirect']);
const OTHER_TABLES=Object.freeze(['film','person','film_external_id','film_redirect','canonical_revision']);
const REUSED=Object.freeze(['schema','marker','fence','baseline','projector_lease','projector_window','discovery_lease']);
const quote=name=>"'"+name+"'";
export const step=(id,purpose,sql,expect)=>({id,purpose,sql:assertReadOnly(sql),expect});

// ---------- the read-only statements ----------
// The lease, window, marker, fence, baseline and schema statements are taken from the 0019 preflight kit, not typed again; the rest are new and fixed.
export function stateSteps(){
 const reused=migrationSteps();
 const pick=(id,purpose,expect)=>{const found=reused.find(item=>item.id===id);if(!found)throw new Error('0019 preflight statement missing: '+id);return step(id,purpose,found.sql,expect);};
 const count=table=>'(SELECT COUNT(*) FROM '+table+') AS '+table;
 const list=names=>names.map(quote).join(', ');
 return [
  pick('schema','schema_contract','one row, version 19, the note of migration 0019'),
  pick('marker','the Film/Person marker','prepared / open / 1 (every phase)'),
  pick('fence','the CAS fence','ok 1'),
  pick('baseline','the activation baseline','verified, the reference named in the GO'),
  pick('projector_lease','the projector lease (the statement of the 0019 preflight)','preflight: no row, lease_id null, or lease_until earlier than now. held and readback: one row naming the lease id of the GO and live. released: lease_id null or no row'),
  pick('projector_window','the projector window (the statement of the 0019 preflight)','idle (every phase)'),
  pick('discovery_lease','the Discovery lease; expires_at is epoch milliseconds (the statement of the 0019 preflight)','preflight and held: no row, lease_id null, or expires_at in the past (epoch milliseconds)'),
  step('receipt_tables','schema 19: the four receipt tables exist',"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ("+list(RECEIPT_TABLES)+") ORDER BY name",'4 rows'),
  step('loader_tables','the tables the loader reads or writes exist',"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ("+list([...CLASSES.map(name=>TABLES[name]),...IDENTITY_TABLES])+") ORDER BY name",'5 rows'),
  step('class_counts','row counts of the three classes','SELECT '+CLASSES.map(name=>count(TABLES[name])).join(', '),'preflight and held: 0 each. readback and released: the pinned counts'),
  step('other_counts','row counts that must not move (and the receipt tables, which must stay empty)','SELECT '+[...OTHER_TABLES,...RECEIPT_TABLES].map(count).join(', '),'receipt tables 0; the others equal to the held bundle (canonical_revision 0 is a note when not)'),
 ];
}
// Not SQL: recorded by hand (the same kind of rows as the 0019 kit).
export const MANUAL_STEPS=Object.freeze([
 'main SHA, the loader and this verifier at that SHA, the deployed Worker version, the D1 database named iptv and its id',
 'epg_status / sync.json stage and the EPG executor phase: no publication in flight (running, switching, metadata, epg mean wait)',
 'the Predictions Task slot: no run in progress (a run rewrites the view index for about 25 minutes of each hour)',
 'the D1 Time Travel bookmark of iptv recorded before the first batch (a recovery point only)',
 'feature flags and the hourly Predictions Task registry, recorded as observed',
]);

// ---------- helpers ----------
function rowsOf(results,id,refusals){
 const value=results?.[id];
 if(value===undefined||value===null){refusals.push('result_missing:'+id);return null;}
 if(Array.isArray(value)&&value.length&&value[0]&&typeof value[0]==='object'&&('success' in value[0]||'results' in value[0])){
  const out=unwrap(value);
  if(out===null){refusals.push('result_failed:'+id);return null;}
  return out;
 }
 if(!Array.isArray(value)||value.some(row=>!row||typeof row!=='object'||Array.isArray(row))){refusals.push('result_malformed:'+id);return null;}
 return value;
}
const int=value=>typeof value==='number'&&Number.isInteger(value)?value:typeof value==='string'&&/^-?\d+$/.test(value)?Number(value):null;
const sameSet=(a,b)=>[...a].sort().join('\n')===[...b].sort().join('\n');
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const verdict=(refusals,notes=[],extra={})=>({ok:refusals.length===0,refusals,notes,...extra});
// A shape-only diagnostic can never be mistaken for a pass: ok is always false.
const diagnosticVerdict=(refusals,notes,extra={})=>({ok:false,diagnosticOnly:true,shapeOk:refusals.length===0,refusals,notes:[...notes,'diagnostic only: pins not required, never a pass'],...extra});
const finish=(diagnostic,refusals,notes,extra)=>diagnostic?diagnosticVerdict(refusals,notes,extra):verdict(refusals,notes,extra);
// pins: the values the GO names. Without them a verification refuses.
export function parseCounts(text){
 if(typeof text!=='string'||text==='')return null;
 const parts=text.split(',');
 if(parts.length!==CLASSES.length||parts.some(part=>!/^\d{1,6}$/.test(part)))return null;
 return parts.map(Number);
}
function countsRefusals(counts){
 if(counts===null||counts===undefined)return ['counts_missing'];
 if(!Array.isArray(counts)||counts.length!==CLASSES.length||counts.some(n=>!Number.isInteger(n)||n<0)||counts.reduce((a,b)=>a+b,0)<1)return ['counts_invalid'];
 return [];
}
function pinRefusals({reference,counts,leaseId,now},{needLease,needCounts}){
 const out=[];
 if(typeof reference!=='string'||reference==='')out.push('expected_reference_missing');
 else if(!REFERENCE.test(reference))out.push('expected_reference_invalid');
 if(needCounts)out.push(...countsRefusals(counts));
 if(needLease){
  if(typeof leaseId!=='string'||leaseId==='')out.push('lease_id_missing');
  else if(!LEASE_ID.test(leaseId))out.push('lease_id_invalid');
 }
 if(typeof now!=='string'||!ISO.test(now)||new Date(now).toISOString()!==now)out.push('now_invalid');
 return out;
}

// The facts that hold in EVERY phase: schema 19, marker prepared/open/1, fence, baseline at the pinned reference, window idle, the tables, the receipt tables empty.
function commonState(results,refusals,{expectReference}){
 const schema=rowsOf(results,'schema',refusals);
 if(schema){
  if(schema.length!==1)refusals.push('schema_contract_rows:'+schema.length);
  else{
   if(int(schema[0].id)!==1)refusals.push('schema_contract_id:'+schema[0].id);
   if(int(schema[0].version)!==SCHEMA_VERSION)refusals.push('schema_version:'+schema[0].version);
   else if(schema[0].note!==NOTE)refusals.push('schema_note_mismatch');
  }
 }
 const marker=rowsOf(results,'marker',refusals);
 if(marker){
  if(marker.length!==1)refusals.push('marker_rows:'+marker.length);
  else if(marker[0].mode!=='prepared'||marker[0].cutover!=='open'||int(marker[0].generation)!==MARKER_GENERATION)refusals.push('marker_moved:'+marker[0].mode+'/'+marker[0].cutover+'/'+marker[0].generation);
 }
 const fence=rowsOf(results,'fence',refusals);
 if(fence){
  if(fence.length!==1)refusals.push('fence_rows:'+fence.length);
  else if(int(fence[0].ok)!==1)refusals.push('fence_not_ok:'+fence[0].ok);
 }
 const baseline=rowsOf(results,'baseline',refusals);
 if(baseline){
  if(baseline.length!==1)refusals.push('baseline_rows:'+baseline.length);
  else{
   if(baseline[0].state!=='verified')refusals.push('baseline_not_verified:'+baseline[0].state);
   else if(typeof baseline[0].reference!=='string'||!REFERENCE.test(baseline[0].reference))refusals.push('baseline_reference_shape');
   else if(typeof expectReference==='string'&&expectReference&&baseline[0].reference!==expectReference)refusals.push('baseline_reference_mismatch');
  }
 }
 const window=rowsOf(results,'projector_window',refusals);
 if(window){
  if(window.length!==1)refusals.push('projector_window_rows:'+window.length);
  else if(window[0].state!=='idle')refusals.push('projector_window_not_idle:'+window[0].state);
 }
 const receiptTables=rowsOf(results,'receipt_tables',refusals);
 if(receiptTables&&!sameSet(receiptTables.map(row=>row.name),RECEIPT_TABLES))refusals.push('receipt_tables_missing');
 const loaderTables=rowsOf(results,'loader_tables',refusals);
 if(loaderTables&&!sameSet(loaderTables.map(row=>row.name),[...CLASSES.map(name=>TABLES[name]),...IDENTITY_TABLES]))refusals.push('loader_tables_missing');
 const others=rowsOf(results,'other_counts',refusals);
 if(others){
  if(others.length!==1)refusals.push('other_counts_rows:'+others.length);
  else for(const table of RECEIPT_TABLES){
   const n=int(others[0][table]);
   if(n===null)refusals.push('count_unreadable:'+table);
   else if(n!==0)refusals.push('receipt_rows_present:'+table+':'+n);
  }
 }
}
function classCounts(results,refusals,expected){
 const counts=rowsOf(results,'class_counts',refusals);
 if(!counts)return;
 if(counts.length!==1){refusals.push('class_counts_rows:'+counts.length);return;}
 CLASSES.forEach((name,index)=>{
  const table=TABLES[name],n=int(counts[0][table]);
  if(n===null)refusals.push('count_unreadable:'+table);
  else if(expected===null&&n!==0)refusals.push('class_not_empty:'+table+':'+n);
  else if(expected!==null&&n!==expected[index])refusals.push('count_not_expected:'+table+':'+n);
 });
}
// The projector lease row against the phase. `leaseId` is the lease id of the GO; `minRemainingMs` is the time the lease must still hold. `bundle` is the held results re-read at readback: identity only, no clock.
function leaseJudge(results,refusals,{phase,leaseId,nowMs,minRemainingMs}){
 const lease=rowsOf(results,'projector_lease',refusals);
 if(!lease)return;
 if(phase==='bundle'){
  if(!(lease.length===1&&lease[0].lease_id===leaseId))refusals.push('projector_lease_not_ours');
  return;
 }
 if(phase==='preflight'){
  if(lease.length>1)refusals.push('projector_lease_rows:'+lease.length);
  else if(lease.length===1&&lease[0].lease_id){
   if(typeof lease[0].lease_until!=='string'||!(Date.parse(lease[0].lease_until)<nowMs))refusals.push('projector_lease_live');
  }
  return;
 }
 if(phase==='released'){
  if(lease.length>1)refusals.push('projector_lease_rows:'+lease.length);
  else if(lease.length===1&&lease[0].lease_id){refusals.push(lease[0].lease_id===leaseId?'lease_not_released':'projector_lease_foreign');}
  return;
 }
 if(lease.length!==1){refusals.push('projector_lease_rows:'+lease.length);return;}
 if(lease[0].lease_id!==leaseId){refusals.push('projector_lease_not_ours:'+lease[0].lease_id);return;}
 const until=typeof lease[0].lease_until==='string'?Date.parse(lease[0].lease_until):NaN;
 if(!(until-nowMs>=minRemainingMs))refusals.push('projector_lease_expiring');
}
function discoveryJudge(results,refusals,nowMs){
 const discovery=rowsOf(results,'discovery_lease',refusals);
 if(!discovery)return;
 for(const row of discovery){
  if(row.lease_id&&!(int(row.expires_at)!==null&&int(row.expires_at)<nowMs))refusals.push('discovery_lease_live');
 }
}
const canon=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);

// phase: 'preflight' (before the lease), 'held' (the run's lease taken, before the first batch: the baseline of what must not move), 'readback' (after the last batch, lease still held),
// 'released' (after the release). options: {expectReference, counts, leaseId, now, held, diagnostic}
export function verifyState(phase,results,{expectReference=null,counts=null,leaseId=null,now=new Date().toISOString(),held=null,diagnostic=false,_bundle=false}={}){
 if(!['preflight','held','readback','released'].includes(phase))throw new Error('unknown phase '+phase);
 const after=phase==='readback'||phase==='released';
 const refusals=[],notes=[];
 const needLease=phase!=='preflight';
 if(!diagnostic)refusals.push(...pinRefusals({reference:expectReference,counts,leaseId,now},{needLease,needCounts:after}));
 commonState(results,refusals,{expectReference});
 classCounts(results,refusals,after?counts:null);
 const nowMs=Date.parse(now);
 leaseJudge(results,refusals,{phase:_bundle?'bundle':phase,leaseId,nowMs,minRemainingMs:phase==='held'?MIN_LEASE_REMAINING_MS:0});
 if((phase==='preflight'||phase==='held')&&!_bundle)discoveryJudge(results,refusals,nowMs);
 const others=rowsOf(results,'other_counts',[]);
 if(phase==='preflight'&&others&&others.length===1&&int(others[0].canonical_revision)!==0)notes.push('canonical_revision_not_empty:'+others[0].canonical_revision);
 if(after){
  if(!_bundle){
   if(record(held)){
    const inner=verifyState('held',held,{expectReference,leaseId,now,diagnostic:true,_bundle:true});
    refusals.push(...inner.refusals.map(item=>'held:'+item));
    const was=rowsOf(held,'other_counts',[]),is=rowsOf(results,'other_counts',[]);
    if(was&&is&&was.length===1&&is.length===1)for(const table of OTHER_TABLES)if(int(was[0][table])!==int(is[0][table]))refusals.push('unchanged_moved:'+table+':'+was[0][table]+'->'+is[0][table]);
    const base=rowsOf(held,'baseline',[]),baseNow=rowsOf(results,'baseline',[]);
    if(base&&baseNow&&base.length===1&&baseNow.length===1&&base[0].reference!==baseNow[0].reference)refusals.push('baseline_reference_changed');
    const windowThen=rowsOf(held,'projector_window',[]),windowNow=rowsOf(results,'projector_window',[]);
    if(windowThen&&windowNow&&canon(windowThen)!==canon(windowNow))refusals.push('projector_window_changed');
    const discoveryThen=rowsOf(held,'discovery_lease',[]),discoveryNow=rowsOf(results,'discovery_lease',[]);
    if(discoveryThen&&discoveryNow&&canon(discoveryThen)!==canon(discoveryNow))notes.push('discovery_lease_moved: a Discovery chunk ran during the load (it writes Discovery tables only); recorded, not a refusal');
   }else if(!diagnostic)refusals.push('held_bundle_missing');
  }
 }
 notes.push('manual rows still to record: '+MANUAL_STEPS.length);
 return finish(diagnostic,refusals,notes);
}

// ---------- the plan summary printed by `plan` ----------
export function verifyPlan(plan,{planDigest=null,counts=null,expectReference=null,at=null,sources={},diagnostic=false}={}){
 const refusals=[],notes=[];
 if(!diagnostic){
  if(typeof planDigest!=='string'||planDigest==='')refusals.push('plan_digest_missing');
  else if(!HEX64.test(planDigest))refusals.push('plan_digest_invalid');
  refusals.push(...pinRefusals({reference:expectReference,counts,leaseId:null,now:typeof at==='string'?at:''},{needLease:false,needCounts:true}).map(item=>item==='now_invalid'?'at_invalid':item));
  for(const id of Object.keys(SOURCE_KEYS)){
   if(typeof sources[id]!=='string'||sources[id]==='')refusals.push('source_sha_missing:'+id);
   else if(!HEX64.test(sources[id]))refusals.push('source_sha_invalid:'+id);
  }
 }
 if(!record(plan)){refusals.push('plan_malformed');return finish(diagnostic,refusals,notes);}
 if('expectedRows' in plan||'batchStatements' in plan)refusals.push('private_plan_pasted');
 if(plan.ok!==true)refusals.push('plan_not_ok');
 if(plan.mode!=='dry-run')refusals.push('plan_not_dry_run');
 if(plan.version!==LOADER_VERSION)refusals.push('plan_version:'+plan.version);
 if(typeof plan.digest!=='string'||!HEX64.test(plan.digest))refusals.push('plan_digest_shape');
 else if(typeof planDigest==='string'&&planDigest!==''&&plan.digest!==planDigest)refusals.push('plan_digest_mismatch');
 const gate=plan.gate;
 if(!record(gate)||gate.mode!=='prepared'||gate.cutover!=='open'||gate.generation!==MARKER_GENERATION)refusals.push('gate_not_prepared:'+(record(gate)?gate.mode+'/'+gate.cutover+'/'+gate.generation:'missing'));
 else if(typeof expectReference==='string'&&expectReference&&gate.baselineReference!==expectReference)refusals.push('gate_reference_mismatch');
 if(typeof at==='string'&&at!==''&&plan.at!==at)refusals.push('plan_at_mismatch');
 if(plan.complete!==true)refusals.push('plan_incomplete');
 if(plan.noop!==false)refusals.push('plan_noop');
 if(plan.deferred!==0)refusals.push('plan_deferred:'+plan.deferred);
 const bounds=plan.bounds;
 const boundsOk=record(bounds)&&Number.isInteger(bounds.batchRows)&&bounds.batchRows>=1&&bounds.batchRows<=BATCH_ROWS&&Number.isInteger(bounds.runBatches)&&bounds.runBatches>=1&&bounds.runBatches<=RUN_BATCHES&&Number.isInteger(bounds.runStatements)&&bounds.runStatements>=1&&bounds.runStatements<=RUN_STATEMENTS;
 if(!boundsOk)refusals.push('bounds_invalid');
 const src=plan.sources;
 for(const id of Object.keys(SOURCE_KEYS)){
  const item=record(src)?src[id]:null;
  if(!record(item)||item.key!==SOURCE_KEYS[id]||typeof item.sha256!=='string'||!HEX64.test(item.sha256)||!Number.isInteger(item.size)||item.size<1||item.size>MAX_SOURCE_BYTES){refusals.push('source_invalid:'+id);continue;}
  if(typeof sources[id]==='string'&&sources[id]!==''&&item.sha256!==sources[id])refusals.push('source_sha_mismatch:'+id);
 }
 let total=0,batches=0;
 CLASSES.forEach((name,index)=>{
  const item=record(plan.classes)?plan.classes[name]:null;
  if(!record(item)){refusals.push('class_missing:'+name);return;}
  const want=Array.isArray(counts)?counts[index]:null;
  if(item.expected!==EXPECTED[name])refusals.push('class_expected_not_loader:'+name+':'+item.expected);
  if(want!==null&&item.planned!==want)refusals.push('class_planned_not_pinned:'+name+':'+item.planned);
  if(want!==null&&item.toLoad!==want)refusals.push('class_toload_not_pinned:'+name+':'+item.toLoad);
  if(item.already!==0)refusals.push('class_already_loaded:'+name+':'+item.already);
  if(item.stored!==0)refusals.push('class_not_empty:'+name+':'+item.stored);
  if(typeof item.digest!=='string'||!HEX64.test(item.digest)||typeof item.toLoadDigest!=='string'||!HEX64.test(item.toLoadDigest))refusals.push('class_digest_shape:'+name);
  else if(item.digest!==item.toLoadDigest)refusals.push('class_digest_not_whole_set:'+name);
  const skipped=record(item.skipped)?Object.entries(item.skipped).filter(([,n])=>n>0).map(([reason,n])=>reason+'='+n):[];
  if(skipped.length)notes.push('skipped '+name+': '+skipped.join(', ')+' (accepted gaps counted, not loaded)');
  if(Number.isInteger(item.toLoad)){total+=item.toLoad;if(boundsOk)batches+=Math.ceil(item.toLoad/bounds.batchRows);}
 });
 if(plan.statements!==total)refusals.push('statements_not_total:'+plan.statements+'/'+total);
 if(boundsOk&&plan.batches!==batches)refusals.push('batches_not_expected:'+plan.batches+'/'+batches);
 if(total>RUN_STATEMENTS||batches>RUN_BATCHES)refusals.push('run_cap_exceeded');
 return finish(diagnostic,refusals,notes,{total,batches});
}

// ---------- the batch list printed by `sql --apply` (metadata only: the SQL stays in the loader's private files) ----------
export function verifyEmitted(output,{planDigest=null,counts=null,batchSetDigest=null,diagnostic=false}={}){
 const refusals=[],notes=[];
 if(!diagnostic){
  if(typeof planDigest!=='string'||planDigest==='')refusals.push('plan_digest_missing');
  else if(!HEX64.test(planDigest))refusals.push('plan_digest_invalid');
  refusals.push(...countsRefusals(counts));
 }
 if(!record(output)){refusals.push('output_malformed');return finish(diagnostic,refusals,notes);}
 if('statements' in output||'sql' in output)refusals.push('sql_pasted');
 if(output.ok!==true)refusals.push('emitted_not_ok');
 if(typeof output.planDigest!=='string'||!HEX64.test(output.planDigest))refusals.push('plan_digest_shape');
 else if(typeof planDigest==='string'&&planDigest!==''&&output.planDigest!==planDigest)refusals.push('plan_digest_mismatch');
 const list=Array.isArray(output.batches)?output.batches:null;
 if(!list||list.length===0){refusals.push('batches_missing');return finish(diagnostic,refusals,notes);}
 if(list.length>RUN_BATCHES)refusals.push('run_cap_exceeded');
 const sums=Object.fromEntries(CLASSES.map(name=>[name,0]));
 let lastClass=0,total=0;
 const seen=new Set();
 list.forEach((batch,index)=>{
  if(!record(batch)){refusals.push('batch_malformed:'+index);return;}
  if(batch.index!==index)refusals.push('batch_index:'+index+':'+batch.index);
  const rank=CLASSES.indexOf(batch.class);
  if(rank<0)refusals.push('batch_class:'+index);
  else{
   if(rank<lastClass)refusals.push('batch_order:'+index);
   lastClass=Math.max(lastClass,rank);
   if(Number.isInteger(batch.rows))sums[batch.class]+=batch.rows;
  }
  if(!Number.isInteger(batch.rows)||batch.rows<1||batch.rows>BATCH_ROWS)refusals.push('batch_rows:'+index+':'+batch.rows);
  else total+=batch.rows;
  if(typeof batch.digest!=='string'||!HEX64.test(batch.digest))refusals.push('batch_digest_shape:'+index);
  else if(seen.has(batch.digest))refusals.push('batch_digest_duplicate:'+index);
  else seen.add(batch.digest);
 });
 if(Array.isArray(counts))CLASSES.forEach((name,index)=>{if(sums[name]!==counts[index])refusals.push('class_rows_not_pinned:'+name+':'+sums[name]);});
 if(total>RUN_STATEMENTS)refusals.push('run_cap_exceeded');
 const setDigest=createHash('sha256').update(list.map(batch=>[batch?.index,batch?.class,batch?.rows,batch?.digest].join(':')).join('\n')).digest('hex');
 if(!diagnostic&&typeof batchSetDigest==='string'&&batchSetDigest!==''&&batchSetDigest!==setDigest)refusals.push('batch_set_digest_mismatch');
 notes.push('batch set digest (name it in the GO): '+setDigest);
 return finish(diagnostic,refusals,notes,{batches:list.length,total,batchSetDigest:setDigest});
}

// ---------- the D1 result of ONE sent batch ----------
// One entry per statement of the batch, each {success, meta:{changes}} (or changes at the top level). A first load changes exactly one row per statement: 0 means the row existed or was skipped, and that is a STOP and a
// readback, never a retry.
export function verifyBatch(response,{rows=null,diagnostic=false}={}){
 const refusals=[];
 if(!diagnostic){
  if(!Number.isInteger(rows)||rows<1||rows>BATCH_ROWS)refusals.push('rows_invalid');
 }
 const list=Array.isArray(response)?response:null;
 if(!list){refusals.push('response_malformed');return finish(diagnostic,refusals,[]);}
 if(Number.isInteger(rows)&&rows>=1&&rows<=BATCH_ROWS&&list.length!==rows)refusals.push('result_count:'+list.length+'/'+rows);
 list.forEach((item,index)=>{
  if(!record(item)){refusals.push('result_malformed:'+index);return;}
  if(item.success!==true){refusals.push('statement_failed:'+index);return;}
  const changes=record(item.meta)&&'changes' in item.meta?item.meta.changes:item.changes;
  if(!Number.isInteger(changes))refusals.push('changes_unreadable:'+index);
  else if(changes===0)refusals.push('statement_no_change:'+index);
  else if(changes!==1)refusals.push('statement_changes:'+index+':'+changes);
 });
 return finish(diagnostic,refusals,['a refusal here is a STOP: read the class counts first, never resend the batch']);
}

// ---------- CLI ----------
export function main(argv){
 const [command,arg]=argv;
 const flag=name=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:null;};
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 const diagnostic=argv.includes('--diagnostic');
 const now=flag('--now')||new Date().toISOString();
 const counts=parseCounts(flag('--counts'));
 const heldFile=flag('--held');
 let out;
 if(command==='state-sql')out={steps:stateSteps(),manual:MANUAL_STEPS};
 else if(command==='verify-preflight'&&arg)out=verifyState('preflight',read(arg),{expectReference:flag('--reference'),now,diagnostic});
 else if(command==='verify-held'&&arg)out=verifyState('held',read(arg),{expectReference:flag('--reference'),leaseId:flag('--lease-id'),now,diagnostic});
 else if((command==='verify-readback'||command==='verify-released')&&arg)out=verifyState(command.slice(7),read(arg),{expectReference:flag('--reference'),leaseId:flag('--lease-id'),counts,now,held:heldFile?read(heldFile):null,diagnostic});
 else if(command==='verify-plan'&&arg)out=verifyPlan(read(arg),{planDigest:flag('--plan-digest'),counts,expectReference:flag('--reference'),at:flag('--at'),sources:{verifiedFilms:flag('--verified-films-sha'),viewIndex:flag('--view-index-sha'),retirements:flag('--retirements-sha')},diagnostic});
 else if(command==='verify-emitted'&&arg)out=verifyEmitted(read(arg),{planDigest:flag('--plan-digest'),counts,batchSetDigest:flag('--batch-set-digest'),diagnostic});
 else if(command==='verify-batch'&&arg)out=verifyBatch(read(arg),{rows:flag('--rows')===null?null:Number(flag('--rows')),diagnostic});
 else{console.error('usage: state-sql | verify-preflight|verify-held|verify-readback|verify-released <results.json> ... | verify-plan <plan.json> ... | verify-emitted <sql-output.json> ... | verify-batch <response.json> --rows N (see the header of this file)');return 2;}
 console.log(JSON.stringify(out,null,1));
 return out.ok===false?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
