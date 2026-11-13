// AIR-374 H1: mutation check of scripts/film-person-h1-verify.mjs. Each mutant is a copy of the module with ONE guard removed or inverted; the test (tests/film-person-h1-verify.mjs, pointed at the mutant through
// VERIFY_MODULE) must FAIL on it. A surviving mutant is a guard no test depends on. The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const source='scripts/film-person-h1-verify.mjs';
const original=fs.readFileSync(source,'utf8');
const MUTANTS=[
 ['read-only guard',"sql:assertReadOnly(sql)","sql"],
 ['schema version constant',"export const SCHEMA_VERSION=21;","export const SCHEMA_VERSION=22;"],
 ['marker generation constant',"export const MARKER_GENERATION=1;","export const MARKER_GENERATION=2;"],
 ['lease margin constant',"export const MIN_LEASE_REMAINING_MS=15*60000;","export const MIN_LEASE_REMAINING_MS=0;"],
 ['envelope failure',"if(out===null){refusals.push('result_failed:'+id);return null;}","if(out===null)return [];"],
 ['missing result',"refusals.push('result_missing:'+id);return null;","return [];"],
 ['malformed result',"refusals.push('result_malformed:'+id);return null;","return [];"],
 ['one schema row',"if(schema.length!==1)refusals.push('schema_contract_rows:'+schema.length);","if(schema.length<1)refusals.push('schema_contract_rows:'+schema.length);"],
 ['schema version',"if(int(schema[0].version)!==SCHEMA_VERSION)refusals.push","if(false)refusals.push"],
 ['schema note',"else if(schema[0].note!==NOTE)refusals.push('schema_note_mismatch');",""],
 ['marker mode',"marker[0].mode!=='prepared'||marker[0].cutover","marker[0].cutover"],
 ['marker cutover',"||marker[0].cutover!=='open'||","||"],
 ['marker generation',"||int(marker[0].generation)!==MARKER_GENERATION)refusals.push('marker_moved","||false)refusals.push('marker_moved"],
 ['fence ok',"else if(int(fence[0].ok)!==1)refusals.push('fence_not_ok:'+fence[0].ok);",""],
 ['baseline verified',"if(baseline[0].state!=='verified')refusals.push('baseline_not_verified:'+baseline[0].state);","if(false)void 0;"],
 ['baseline reference shape',"else if(typeof baseline[0].reference!=='string'||!REFERENCE.test(baseline[0].reference))refusals.push('baseline_reference_shape');",""],
 ['baseline reference pinned',"else if(typeof expectReference==='string'&&expectReference&&baseline[0].reference!==expectReference)refusals.push('baseline_reference_mismatch');",""],
 ['window idle',"else if(window[0].state!=='idle')refusals.push('projector_window_not_idle:'+window[0].state);",""],
 ['receipt tables exist',"if(receiptTables&&!sameSet(receiptTables.map(row=>row.name),RECEIPT_TABLES))refusals.push('receipt_tables_missing');",""],
 ['loader tables exist',"if(loaderTables&&!sameSet(loaderTables.map(row=>row.name),[...CLASSES.map(name=>TABLES[name]),...IDENTITY_TABLES]))refusals.push('loader_tables_missing');",""],
 ['receipt tables empty',"else if(n!==0)refusals.push('receipt_rows_present:'+table+':'+n);","else void 0;"],
 ['class empty before the load',"else if(expected===null&&n!==0)refusals.push('class_not_empty:'+table+':'+n);",""],
 ['class pinned after the load',"else if(expected!==null&&n!==expected[index])refusals.push('count_not_expected:'+table+':'+n);",""],
 ['bundle lease identity',"if(!(lease.length===1&&lease[0].lease_id===leaseId))refusals.push('projector_lease_not_ours');","void 0;"],
 ['preflight lease live',"if(typeof lease[0].lease_until!=='string'||!(Date.parse(lease[0].lease_until)<nowMs))refusals.push('projector_lease_live');",""],
 ['preflight lease until strict',"!(Date.parse(lease[0].lease_until)<nowMs)","false"],
 ['released lease gone',"refusals.push(lease[0].lease_id===leaseId?'lease_not_released':'projector_lease_foreign');","void 0;"],
 ['released lease foreign',"lease[0].lease_id===leaseId?'lease_not_released':'projector_lease_foreign'","'lease_not_released'"],
 ['held lease ours',"if(lease[0].lease_id!==leaseId){refusals.push('projector_lease_not_ours:'+lease[0].lease_id);return;}","void 0;"],
 ['held lease time left',"if(!(until-nowMs>=minRemainingMs))refusals.push('projector_lease_expiring');",""],
 ['held lease margin inclusive',"until-nowMs>=minRemainingMs","until-nowMs>minRemainingMs"],
 ['discovery lease live',"if(row.lease_id&&!(int(row.expires_at)!==null&&int(row.expires_at)<nowMs))refusals.push('discovery_lease_live');","void 0;"],
 ['discovery judged at preflight and held',"if((phase==='preflight'||phase==='held')&&!_bundle)discoveryJudge","if(false)discoveryJudge"],
 ['held bundle re-judged',"const inner=verifyState('held',held,{expectReference,leaseId,now,diagnostic:true,_bundle:true});\n    refusals.push(...inner.refusals.map(item=>'held:'+item));","void 0;"],
 ['unchanged counts',"if(was&&is&&was.length===1&&is.length===1)for(const table of OTHER_TABLES)if(int(was[0][table])!==int(is[0][table]))refusals.push('unchanged_moved:'+table+':'+was[0][table]+'->'+is[0][table]);",""],
 ['baseline reference changed',"if(base&&baseNow&&base.length===1&&baseNow.length===1&&base[0].reference!==baseNow[0].reference)refusals.push('baseline_reference_changed');",""],
 ['window unchanged',"if(windowThen&&windowNow&&canon(windowThen)!==canon(windowNow))refusals.push('projector_window_changed');",""],
 ['held bundle required',"}else if(!diagnostic)refusals.push('held_bundle_missing');","}else void 0;"],
 ['pins skipped in diagnostic only',"if(!diagnostic)refusals.push(...pinRefusals({reference:expectReference,counts,leaseId,now},{needLease,needCounts:after}));","void 0;"],
 ['lease pin for later phases',"const needLease=phase!=='preflight';","const needLease=false;"],
 ['reference missing',"if(typeof reference!=='string'||reference==='')out.push('expected_reference_missing');","if(false)void 0;"],
 ['reference invalid',"else if(!REFERENCE.test(reference))out.push('expected_reference_invalid');",""],
 ['counts missing',"if(counts===null||counts===undefined)return ['counts_missing'];","void 0;"],
 ['counts invalid',"counts.reduce((a,b)=>a+b,0)<1)return ['counts_invalid'];","false)return ['counts_invalid'];"],
 ['lease id missing',"if(typeof leaseId!=='string'||leaseId==='')out.push('lease_id_missing');","if(false)void 0;"],
 ['lease id invalid',"else if(!LEASE_ID.test(leaseId))out.push('lease_id_invalid');",""],
 ['now invalid',"if(typeof now!=='string'||!ISO.test(now)||new Date(now).toISOString()!==now)out.push('now_invalid');","void 0;"],
 // the plan summary
 ['plan digest pin missing',"if(typeof planDigest!=='string'||planDigest==='')refusals.push('plan_digest_missing');\n  else if(!HEX64.test(planDigest))refusals.push('plan_digest_invalid');\n  refusals.push(...pinRefusals","void 0;\n  if(false)void 0;\n  refusals.push(...pinRefusals"],
 ['plan at pin',".map(item=>item==='now_invalid'?'at_invalid':item)",""],
 ['plan source pins',"if(typeof sources[id]!=='string'||sources[id]==='')refusals.push('source_sha_missing:'+id);","if(false)void 0;"],
 ['private plan',"if('expectedRows' in plan||'batchStatements' in plan)refusals.push('private_plan_pasted');","void 0;"],
 ['plan ok',"if(plan.ok!==true)refusals.push('plan_not_ok');",""],
 ['plan dry run',"if(plan.mode!=='dry-run')refusals.push('plan_not_dry_run');",""],
 ['plan version',"if(plan.version!==LOADER_VERSION)refusals.push('plan_version:'+plan.version);",""],
 ['plan digest equal',"else if(typeof planDigest==='string'&&planDigest!==''&&plan.digest!==planDigest)refusals.push('plan_digest_mismatch');",""],
 ['plan gate mode',"gate.mode!=='prepared'||gate.cutover!=='open'||gate.generation!==MARKER_GENERATION","false"],
 ['plan gate reference',"else if(typeof expectReference==='string'&&expectReference&&gate.baselineReference!==expectReference)refusals.push('gate_reference_mismatch');",""],
 ['plan at',"if(typeof at==='string'&&at!==''&&plan.at!==at)refusals.push('plan_at_mismatch');",""],
 ['plan complete',"if(plan.complete!==true)refusals.push('plan_incomplete');",""],
 ['plan noop',"if(plan.noop!==false)refusals.push('plan_noop');",""],
 ['plan deferred',"if(plan.deferred!==0)refusals.push('plan_deferred:'+plan.deferred);",""],
 ['plan bounds batch rows',"bounds.batchRows>=1&&bounds.batchRows<=BATCH_ROWS&&","bounds.batchRows>=1&&"],
 ['plan source pinned',"if(typeof sources[id]==='string'&&sources[id]!==''&&item.sha256!==sources[id])refusals.push('source_sha_mismatch:'+id);",""],
 ['plan class expected',"if(item.expected!==EXPECTED[name])refusals.push('class_expected_not_loader:'+name+':'+item.expected);",""],
 ['plan class planned',"if(want!==null&&item.planned!==want)refusals.push('class_planned_not_pinned:'+name+':'+item.planned);",""],
 ['plan class to load',"if(want!==null&&item.toLoad!==want)refusals.push('class_toload_not_pinned:'+name+':'+item.toLoad);",""],
 ['plan class already',"if(item.already!==0)refusals.push('class_already_loaded:'+name+':'+item.already);",""],
 ['plan class stored',"if(item.stored!==0)refusals.push('class_not_empty:'+name+':'+item.stored);",""],
 ['plan class digest whole',"else if(item.digest!==item.toLoadDigest)refusals.push('class_digest_not_whole_set:'+name);",""],
 ['plan batch arithmetic',"batches+=Math.ceil(item.toLoad/bounds.batchRows)","batches+=Math.floor(item.toLoad/bounds.batchRows)"],
 ['plan statements',"if(plan.statements!==total)refusals.push('statements_not_total:'+plan.statements+'/'+total);",""],
 ['plan batches',"if(boundsOk&&plan.batches!==batches)refusals.push('batches_not_expected:'+plan.batches+'/'+batches);",""],
 ['plan run cap',"if(total>RUN_STATEMENTS||batches>RUN_BATCHES)refusals.push('run_cap_exceeded');",""],
 // the emitted batch list
 ['emitted digest pin',"if(typeof planDigest!=='string'||planDigest==='')refusals.push('plan_digest_missing');\n  else if(!HEX64.test(planDigest))refusals.push('plan_digest_invalid');\n  refusals.push(...countsRefusals(counts));","void 0;\n  refusals.push(...countsRefusals(counts));"],
 ['emitted sql pasted',"if('statements' in output||'sql' in output)refusals.push('sql_pasted');",""],
 ['emitted ok',"if(output.ok!==true)refusals.push('emitted_not_ok');",""],
 ['emitted digest equal',"else if(typeof planDigest==='string'&&planDigest!==''&&output.planDigest!==planDigest)refusals.push('plan_digest_mismatch');",""],
 ['emitted batches present',"if(!list||list.length===0){refusals.push('batches_missing');return finish(diagnostic,refusals,notes);}","void 0;"],
 ['emitted batch cap',"if(list.length>RUN_BATCHES)refusals.push('run_cap_exceeded');",""],
 ['emitted batch index',"if(batch.index!==index)refusals.push('batch_index:'+index+':'+batch.index);",""],
 ['emitted batch order',"if(rank<lastClass)refusals.push('batch_order:'+index);",""],
 ['emitted batch rows',"if(!Number.isInteger(batch.rows)||batch.rows<1||batch.rows>BATCH_ROWS)refusals.push('batch_rows:'+index+':'+batch.rows);","if(!Number.isInteger(batch.rows)||batch.rows<1)refusals.push('batch_rows:'+index+':'+batch.rows);"],
 ['emitted batch digest unique',"else if(seen.has(batch.digest))refusals.push('batch_digest_duplicate:'+index);",""],
 ['emitted class sums',"if(Array.isArray(counts))CLASSES.forEach((name,index)=>{if(sums[name]!==counts[index])refusals.push('class_rows_not_pinned:'+name+':'+sums[name]);});",""],
 ['emitted run statements',"if(total>RUN_STATEMENTS)refusals.push('run_cap_exceeded');",""],
 ['emitted set digest pin',"if(!diagnostic&&typeof batchSetDigest==='string'&&batchSetDigest!==''&&batchSetDigest!==setDigest)refusals.push('batch_set_digest_mismatch');",""],
 // one batch result
 ['batch rows pin',"if(!Number.isInteger(rows)||rows<1||rows>BATCH_ROWS)refusals.push('rows_invalid');","void 0;"],
 ['batch result count',"if(Number.isInteger(rows)&&rows>=1&&rows<=BATCH_ROWS&&list.length!==rows)refusals.push('result_count:'+list.length+'/'+rows);",""],
 ['batch success',"if(item.success!==true){refusals.push('statement_failed:'+index);return;}","void 0;"],
 ['batch no change',"else if(changes===0)refusals.push('statement_no_change:'+index);",""],
 ['batch one change',"else if(changes!==1)refusals.push('statement_changes:'+index+':'+changes);",""],
 // the private plan: lease id and window owner bound to the GO
 ['private lease pin missing',"if(typeof leaseId!=='string'||leaseId==='')refusals.push('lease_id_missing');\n else if(!LEASE_ID.test(leaseId))refusals.push('lease_id_invalid');\n if(windowOwner!==null","void 0;\n if(windowOwner!==null"],
 ['private lease pin shape',"else if(!LEASE_ID.test(leaseId))refusals.push('lease_id_invalid');\n if(windowOwner!==null",";\n if(windowOwner!==null"],
 ['private window pin shape',"if(windowOwner!==null&&(typeof windowOwner!=='string'||!LEASE_ID.test(windowOwner)))refusals.push('window_owner_invalid');",""],
 ['private plan shape',"if(!record(plan)||!record(plan.expectedRows)||!Array.isArray(plan.batchStatements)||!Array.isArray(plan.batches)||!record(plan.classes)){refusals.push('private_plan_malformed');return verdict(refusals);}","void 0;"],
 ['private digest recomputed',"if(typeof digest!=='string'||!HEX64.test(digest)||sha(stable(core))!==digest)refusals.push('plan_tampered');",""],
 ['private lease equal',"if(plan.leaseId!==leaseId)refusals.push('lease_id_mismatch');",""],
 ['private window unpinned',"if(windowOwner===null){if(plan.windowOwner!==null)refusals.push('window_owner_not_pinned');}","if(windowOwner===null){void 0;}"],
 ['private window equal',"else if(plan.windowOwner!==windowOwner)refusals.push('window_owner_mismatch');",""],
 ['private batch count',"if(batchStatements.length!==plan.batches.length)refusals.push('batch_count_mismatch');",""],
 ['private batch digest',"if(record(plan.batches[index])&&sha(stable(list))!==plan.batches[index].digest)refusals.push('batch_digest_mismatch:'+index);",""],
 ['private statement lease',"if(!params.includes(leaseId))guardLease++;",""],
 ['private statement window',"if(windowOwner!==null?!params.includes(windowOwner):text.includes('projector_window'))guardWindow++;",""],
 ['private summary checks',"refusals.push(...inner.refusals);total=inner.total??0;","total=inner.total??0;"],
 ['cli private plan unreadable',"const readSafe=file=>{try{return read(file);}catch{return null;}};","const readSafe=file=>read(file);"],
 ['cli private plan diagnostic',"out=diagnostic?{ok:false,refusals:['diagnostic_not_allowed'],notes:[]}:verifyPrivatePlan(","out=verifyPrivatePlan("],
 ['cli private plan lease flag',"leaseId:flag('--lease-id'),windowOwner:flag('--window-owner')","leaseId:null,windowOwner:flag('--window-owner')"],
 ['cli private plan window flag',"windowOwner:flag('--window-owner'),counts","windowOwner:null,counts"],
 // verdicts and CLI
 ['verdict ok',"ok:refusals.length===0,refusals,notes,...extra","ok:true,refusals,notes,...extra"],
 ['diagnostic never ok',"({ok:false,diagnosticOnly:true,shapeOk:refusals.length===0,","({ok:refusals.length===0,diagnosticOnly:true,shapeOk:refusals.length===0,"],
 ['finish routes diagnostic',"const finish=(diagnostic,refusals,notes,extra)=>diagnostic?diagnosticVerdict(refusals,notes,extra):verdict(refusals,notes,extra);","const finish=(diagnostic,refusals,notes,extra)=>verdict(refusals,notes,extra);"],
 ['cli diagnostic',"const diagnostic=argv.includes('--diagnostic');","const diagnostic=false;"],
 ['cli refusal exit',"return out.ok===false?1:0;","return 0;"],
 ['cli held bundle',"held:heldFile?read(heldFile):null","held:null"],
];
const bad=MUTANTS.filter(([,from])=>original.split(from).length!==2).map(([name,from])=>name+' ('+(original.split(from).length-1)+' occurrences)');
assert.deepEqual(bad,[],'the mutation text must occur exactly once in '+source+': '+bad.join(', '));
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'h1-verify-mutants-'));
const abs=name=>pathToFileURL(path.resolve('scripts/'+name)).href;
// the copy lives outside the tree: its imports and its repository root are pinned to this checkout
const moved=text=>text.replace("'./schema-preflight.mjs'",JSON.stringify(abs('schema-preflight.mjs'))).replace("'./film-person-0019-preflight.mjs'",JSON.stringify(abs('film-person-0019-preflight.mjs'))).replace("'./film-person-prepared-loader.mjs'",JSON.stringify(abs('film-person-prepared-loader.mjs')));
const run=file=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-h1-verify.mjs'],{env:{...process.env,VERIFY_MODULE:file},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even parse or load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError/.test(err),'broken mutant '+file+': '+err.slice(0,300));resolve(code);});
});
try{
 // the unmutated copy, moved the same way, must PASS: otherwise every mutant would be "killed" by the move itself
 const control=path.join(dir,'control.mjs');
 fs.writeFileSync(control,moved(original));
 assert.equal(await run(control),0,'the unmutated, moved copy must pass');
 const queue=MUTANTS.map(([name,from,to],index)=>{
  const file=path.join(dir,'mutant'+index+'.mjs');
  fs.writeFileSync(file,moved(original.replace(from,()=>to)));
  return {name,file};
 });
 const survivors=[];
 const workers=Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.file)===0)survivors.push(item.name);}});
 await Promise.all(workers);
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('film-person-h1-verify-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
