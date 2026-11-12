// AIR-374 H0: mutation check of scripts/film-person-0019-preflight.mjs. Each mutant is a copy of the module with ONE guard removed or inverted; the test
// (tests/film-person-0019-preflight.mjs, pointed at the mutant through PREFLIGHT_MODULE) must FAIL on it. A surviving mutant is a guard no test depends on.
// The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const source='scripts/film-person-0019-preflight.mjs';
const original=fs.readFileSync(source,'utf8');
const MUTANTS=[
 ['git blob header',"Buffer.from('blob '+bytes.length+'\\0')","Buffer.from('')"],
 ['sha256 of the bytes',"sha256:createHash('sha256').update(bytes).digest('hex'),","sha256:createHash('sha256').update(text.trim()).digest('hex'),"],
 ['byte count not characters',"bytes:bytes.length,","bytes:text.length,"],
 ['statement count',"/^(INSERT|CREATE|UPDATE)\\b/","/^(CREATE)\\b/"],
 ['expected first changes',"firstChanges:0,lastChanges:1","firstChanges:1,lastChanges:1"],
 ['prerequisite count',"if(out.length!==8)throw","if(false)throw"],
 ['prerequisite token strict',"if(!token)throw new Error('unexpected object name in the prerequisite list');","if(!token)return '';"],
 ['name guard',"if(!NAMES.test(name))throw new Error('unexpected object name '+name);","void 0;"],
 ['read-only guard',"sql:assertReadOnly(sql)","sql"],
 ['glob inventory',"name GLOB 'canonical_*receipt*' ORDER BY type, name\",'0 rows')","name GLOB 'canonical_write_receipt' ORDER BY type, name\",'0 rows')"],
 ['readback includes shared trigger',"...rec.triggers,SHARED_TRIGGER].sort()","...rec.triggers].sort()"],
 ['envelope failure',"if(out===null){refusals.push('result_failed:'+id);return null;}","if(out===null)return [];"],
 ['missing result',"refusals.push('result_missing:'+id);return null;","return [];"],
 ['malformed result',"refusals.push('result_malformed:'+id);return null;","return [];"],
 ['one schema row',"if(schema.length!==1)refusals.push('schema_contract_rows:'+schema.length);","if(schema.length<1)refusals.push('schema_contract_rows:'+schema.length);"],
 ['schema id',"if(int(schema[0].id)!==1)refusals.push('schema_contract_id:'+schema[0].id);","void 0;"],
 ['schema version',"if(int(schema[0].version)!==expectVersion)refusals.push","if(false)refusals.push"],
 ['schema note',"else if(expectVersion===TO_VERSION&&schema[0].note!==NOTE)refusals.push('schema_note_mismatch');",""],
 ['marker mode',"marker[0].mode!=='prepared'||marker[0].cutover","marker[0].cutover"],
 ['marker cutover',"||marker[0].cutover!=='open'||","||"],
 ['marker generation',"||int(marker[0].generation)!==1)refusals.push('marker_moved","||false)refusals.push('marker_moved"],
 ['marker single row',"if(marker.length!==1)refusals.push('marker_rows:'+marker.length);","if(marker.length<1)refusals.push('marker_rows:'+marker.length);"],
 ['fence ok',"else if(int(fence[0].ok)!==1)refusals.push('fence_not_ok:'+fence[0].ok);",""],
 ['baseline verified',"if(baseline[0].state!=='verified')refusals.push('baseline_not_verified:'+baseline[0].state);","if(false)void 0;"],
 ['baseline reference shape',"else if(typeof baseline[0].reference!=='string'||!REFERENCE.test(baseline[0].reference))refusals.push('baseline_reference_shape');",""],
 ['baseline reference pinned',"else if(typeof expectReference==='string'&&expectReference&&baseline[0].reference!==expectReference)refusals.push('baseline_reference_mismatch');",""],
 ['reference digest length',"[0-9a-f]{64}$/","[0-9a-f]+$/"],
 ['prerequisites complete',"if(!sameSet(prereq.map(row=>row.name),want))refusals.push","if(false)refusals.push"],
 ['existing objects',"if(existing&&existing.length)refusals.push('receipt_objects_present:'+existing.length);",""],
 ['shared trigger present',"if(shared&&!(shared.length===1&&shared[0].name===SHARED_TRIGGER))refusals.push('shared_trigger_missing');",""],
 ['revision unreadable',"if(revision.length!==1||int(revision[0].n)===null)refusals.push('canonical_revision_unreadable');","if(false)void 0;"],
 ['revision note',"notes.push('canonical_revision_not_empty:'+revision[0].n)","void 0"],
 ['lease rows',"if(lease.length>1)refusals.push('projector_lease_rows:'+lease.length);","if(false)void 0;"],
 ['lease live',"if(typeof lease[0].lease_until!=='string'||!(lease[0].lease_until<now))refusals.push('projector_lease_live');",""],
 ['lease until strict',"!(lease[0].lease_until<now)","false"],
 ['window rows',"if(window.length!==1)refusals.push('projector_window_rows:'+window.length);","if(false)void 0;"],
 ['window idle',"else if(window[0].state!=='idle')refusals.push('projector_window_not_idle:'+window[0].state);",""],
 ['discovery lease',"if(row.lease_id&&!(int(row.expires_at)!==null&&int(row.expires_at)<nowMs))refusals.push('discovery_lease_live');",""],
 ['discovery expiry ms',"int(row.expires_at)<nowMs","int(row.expires_at)<nowMs+1e12"],
 ['objects missing',"if(missing.length)refusals.push('objects_missing:'+missing.join(','));",""],
 ['objects unexpected',"if(extra.length)refusals.push('objects_unexpected:'+extra.join(','));",""],
 ['object type counted',"const have=new Set(objects.map(row=>row.type+':'+row.name));","const have=new Set(objects.map(row=>'table:'+row.name));"],
 ['shape guard',"if(rec.tables.length!==4||rec.indexes.length!==2||rec.triggers.length!==19)refusals.push","if(false)refusals.push"],
 ['foreign objects',"if(foreign&&foreign.length)refusals.push(","if(false)refusals.push("],
 ['count rows',"if(counts.length!==1){refusals.push(id+'_rows:'+counts.length);continue;}","if(counts.length<1){continue;}"],
 ['count unreadable',"if(n===null)refusals.push('count_unreadable:'+table);","if(n===null)void 0;"],
 ['count expected',"else if(n!==want)refusals.push('count_not_expected:'+table+':'+n);",""],
 ['count default zero',"expectedCounts[table]??0","expectedCounts[table]??n"],
 ['receipt tables counted',"['receipt_rows',RECEIPT_TABLES],","['receipt_rows',[]],"],
 ['unchanged tables counted',"['unchanged_rows',H1_TABLES]]","['unchanged_rows',[]]]"],
 ['pin missing',"if(typeof expectReference!=='string'||expectReference==='')return ['expected_reference_missing'];","if(false)return [];"],
 ['pin invalid',"if(!REFERENCE.test(expectReference))return ['expected_reference_invalid'];",""],
 ['pin enforced in preflight',"if(!diagnostic)refusals.push(...pinRefusals(expectReference));\n commonState(results,refusals,{expectVersion:FROM_VERSION","commonState(results,refusals,{expectVersion:FROM_VERSION"],
 ['pin enforced in readback',"if(!diagnostic)refusals.push(...pinRefusals(expectReference));\n commonState(results,refusals,{expectVersion:TO_VERSION","commonState(results,refusals,{expectVersion:TO_VERSION"],
 ['diagnostic never ok',"{ok:false,diagnosticOnly:true,","{ok:true,diagnosticOnly:true,"],
 ['diagnostic shape flag',"shapeOk:refusals.length===0,","shapeOk:true,"],
 ['diagnostic note',"'diagnostic only: no pinned reference, never a GO pass'","'x'"],
 ['preflight diagnostic result',"return diagnostic?diagnosticVerdict(refusals,notes):verdict(refusals,notes);","return verdict(refusals,notes);"],
 ['readback diagnostic result',"return diagnostic?diagnosticVerdict(refusals,[]):verdict(","return verdict(refusals,[]);//("],
 ['bundle required',"if(!diagnostic)refusals.push('preflight_bundle_missing');return;}","return;}"],
 ['bundle is version 18',"if(schema&&!(schema.length===1&&int(schema[0].version)===FROM_VERSION))own.push('preflight_not_version_18');",""],
 ['bundle reference shape',"if(baseline&&!(typeof preRef==='string'&&REFERENCE.test(preRef)))own.push('baseline_reference_shape');","if(false)own.push('x');"],
 ['bundle rows prefixed',"refusals.push(...own.map(item=>'preflight:'+item),...changed);","refusals.push(...own.map(item=>item),...changed);"],
 ['reference changed',"if(post&&post.length===1&&post[0].reference!==preRef)changed.push('baseline_reference_changed');",""],
 ['preflight reference pinned',"if(!diagnostic&&typeof expectReference==='string'&&expectReference&&preRef!==expectReference)changed.push('preflight_reference_mismatch');",""],
 ['lease window compared',"if(a&&b&&canon(a)!==canon(b))changed.push(id+'_changed');",""],
 ['canonical row compare',"JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item)","JSON.stringify(value)"],
 ['compared list',"['projector_lease','projector_window','discovery_lease']","['projector_lease','projector_window']"],
 ['compared results required',"for(const id of COMPARED)rowsOf(results,id,refusals);",""],
 ['readback emits compared',"...preflightSteps(text).filter(item=>COMPARED.includes(item.id)),",""],
 ['cli preflight bundle',"preflight:pre?read(pre):null","preflight:null"],
 ['cli diagnostic',"expectReference:flag('--reference'),diagnostic:argv.includes('--diagnostic')});\n else if","expectReference:flag('--reference')});\n else if"],
 ['verdict ok',"ok:refusals.length===0","ok:true"],
 ['cli refusal exit',"return out.ok===false?1:0;","return 0;"],
];
for(const [name,from] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+source);
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'preflight-0019-mutants-'));
const schemaPreflight=pathToFileURL(path.resolve('scripts/schema-preflight.mjs')).href;
// the copy lives outside the tree: its imports and its repository root are pinned to this checkout
const moved=text=>text.replace("'./schema-preflight.mjs'",JSON.stringify(schemaPreflight)).replace("path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')",JSON.stringify(process.cwd()));
const run=file=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-0019-preflight.mjs'],{env:{...process.env,PREFLIGHT_MODULE:file},stdio:['ignore','ignore','pipe']});
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
 console.log('film-person-0019-preflight-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
