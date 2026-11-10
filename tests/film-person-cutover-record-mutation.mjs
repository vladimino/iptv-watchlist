// AIR-373: mutation check of the essential guards of the explicit recording path (src/film-person-baseline.js, tested by tests/film-person-cutover-record.mjs) and
// of the measuring run that derives `verified` (scripts/film-person-cutover-run.mjs, tested by tests/film-person-cutover-run.mjs). Each mutant is a copy of ONE
// module with ONE guard removed or inverted; the module's test, pointed at the mutant through an environment variable, must FAIL on it. A surviving mutant is a
// guard no test depends on. A mutant that does not parse or load is a BROKEN mutant and fails this check: it is never counted as killed.
// The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const RECORDER=[
 ['strict is only the default or its own name',"if(path===undefined||pathIs(path,RECORDING_PATHS.strict))return","if(true)return"],
 ['unknown path refused',"if(!pathIs(path,RECORDING_PATHS.cutover_minimum))throw failed('baseline_path_invalid');",''],
 ['path matched exactly',"&&stable(path)===stable(known);","&&path.gate===known.gate;"],
 ['cutover gate consulted',"const gate=await cutoverMinimumGate(ledger);","const gate={gate:'cutover_minimum',version:1,pass:true,reasons:[]};"],
 ['gate reasons carried',"const reasons=[...gate.reasons];","const reasons=[];"],
 ['recorder reasons enforced',"pass:gate.pass===true&&reasons.length===0","pass:gate.pass===true"],
 ['generation binding',"if(!(marker&&marker.mode==='r2'&&marker.generation===expectedGeneration))reasons.push('ledger_generation_mismatch');",''],
 ['generation binding: marker r2',"marker&&marker.mode==='r2'&&marker.generation","marker&&marker.generation"],
 ['generation binding: same generation',"&&marker.generation===expectedGeneration))","))"],
 ['reference names the gate',"reference:recordingReference(path,ledger?.cutoverDigest)","reference:ledger?.cutoverDigest"],
 ['reference format',"path.gate+'/v'+path.version+':'+digest","digest"],
 ['failing gate throws',"if(!gate.pass){const error=failed('baseline_gate_failed');error.reasons=gate.reasons;throw error;}",''],
 ['replay is a no-op',"if(row?.state==='verified'&&row.reference===reference)return {state:'verified',reference,already:true};",''],
 ['different ledger refused',"row?.state==='verified'&&row.reference===reference","row?.state==='verified'"],
 ['strict gate consulted',"return {gate:await baselineGate(ledger),reference:ledger?.digest};","return {gate:{pass:true,reasons:[]},reference:ledger?.digest};"],
];
const RUN=[
 ['R2 transport must be production',"if(transportKind(client)!=='r2')reasons.push('source_transport_not_production:r2');",''],
 ['D1 transport must be production',"reasons.push('source_transport_not_production:d1');","void 0;"],
 ['verified follows the transport',"const verified=transport.length===0;","const verified=true;"],
 ['ledger source carries the derived verdict',"source:{aggregateSha256:manifest.digest,verified,kind","source:{aggregateSha256:manifest.digest,verified:true,kind"],
 ['no ledger for a refused run',"if(reasons.length)return refused(reasons,run);",''],
 ['R2 endpoint override',"const r2=!credentials.endpointOverride&&","const r2="],
 ['R2 production bucket',"credentials.bucket===PRODUCTION_BUCKET&&",''],
 ['D1 endpoint override',"const d1=!target.endpointOverride&&","const d1="],
 ['D1 production database name',"&&target.databaseName===TARGET_DATABASE_NAME;",";"],
 ['R2 registered only when production',"if(r2)PRODUCTION.set(client,","PRODUCTION.set(client,"],
 ['D1 registered only when production',"if(d1)PRODUCTION.set(db,","PRODUCTION.set(db,"],
 ['D1 described name',"seen.name===TARGET_DATABASE_NAME&&",''],
 ['D1 described id',"&&seen.uuid===entry.databaseId",''],
 ['D1 description required',"reasons.push('source_transport_identity:d1');","void 0;"],
 ['manifest verified',"for(const item of run.manifestProblems||['unchecked'])reasons.push('manifest_invalid:'+item);",''],
 ['manifest check not skipped',"run.manifestProblems||['unchecked']","run.manifestProblems||[]"],
 ['derived payloads verified',"for(const item of run.derivedProblems||['unchecked'])reasons.push('derived_invalid:'+item);",''],
 ['derived check not skipped',"run.derivedProblems||['unchecked']","run.derivedProblems||[]"],
 ['unknown object',"if(!known.has(entry?.id))reasons.push('probe_incomplete:unknown_object');",''],
 ['routed object not requested',"if(found.length)reasons.push('probe_incomplete:routed_object:'+item.id);",''],
 ['one entry per key',"if(found.length!==1||key===null||entry.key!==key)","if(!entry||key===null||entry.key!==key)"],
 ['entry at its resolved key',"||key===null||entry.key!==key)","||key===null)"],
 ['present entry has ETag and digest',"if(typeof entry.etag!=='string'||!entry.etag||!HEX64.test(String(entry.sha256||'')))reasons.push('probe_incomplete:'+item.id);",''],
 ['required key present',"else if(entry.state!=='absent'||item.required)","else if(entry.state!=='absent')"],
 ['entry state known',"else if(entry.state!=='absent'||item.required)","else if(entry.state==='absent'&&item.required)"],
 ['every key observed after the cut',"if(after.length!==manifest.objects.length)reasons.push('probe_incomplete:etags_after_cut');",''],
 ['observation after the cut usable',"reasons.push('probe_incomplete:etag_after_cut:'+entry.id);","void 0;"],
 ['ETag unchanged after the cut',"reasons.push('etag_changed_after_cut:'+entry.id);","void 0;"],
 ['ETags are observed, not copied',"{key:entry.key,state:'present',etag:current.etag}","{key:entry.key,state:'present',etag:entry.etag}"],
 ['D1 identity read at every stage',"if(!record(gate)){reasons.push('d1_identity_missing:'+stage);continue;}","if(!record(gate))continue;"],
 ['D1 identity unchanged',"for(const item of identityMoved(gates.captureBefore,gate))reasons.push(item.replace('d1_identity_moved:','d1_identity_moved:'+stage+':'));",''],
 ['fence held',"if(gate.fence?.ok!==1)reasons.push('fence_lost:'+stage);",''],
 ['no foreign projector lease',"if(gate.lease?.held!==false)reasons.push('lease_foreign:projector:'+stage);",''],
 ['no foreign window',"if(gate.window?.live!==false)reasons.push('lease_foreign:window:'+stage);",''],
 ['no foreign discovery lease',"if(gate.discoveryLease?.live!==false)reasons.push('lease_foreign:discovery:'+stage);",''],
 ['cut complete',"if(cut.done!==true)reasons.push('probe_incomplete:cut');",''],
 ['cut consistent',"if(cut.consistent!==true)reasons.push('cut_not_consistent');",''],
 ['cut reasons carried',"reasons.push(/^lease_/.test(item)?'lease_lost:'+item:'cut:'+item);","void 0;"],
 ['every class read',"for(const name of Array.isArray(cut.unavailable)?cut.unavailable:['unknown'])reasons.push('probe_incomplete:class:'+name);",''],
 ['lease held at the start',"reasons.push('lease_lost:not_held_at_start');","void 0;"],
 ['lease held at the end',"reasons.push('lease_lost:not_held_at_end');","void 0;"],
 ['lease is ours at the end',"cut.leaseAfter?.id!==run.leaseId||",''],
 ['witness readable',"if(!record(witness[stage]))reasons.push('witness_unreadable:'+stage);\n  else if","if(!record(witness[stage]))void 0;\n  else if"],
 ['witness unchanged',"reasons.push('witness_moved:'+stage);","void 0;"],
 ['owner facts readable',"reasons.push('owner_facts_unreadable');\n","void 0;\n"],
 ['owner facts unchanged',"else if(stable(facts.before)!==stable(facts.after))reasons.push('owner_facts_changed');",''],
 ['fence flag derived',"fenceHeld:!any(/^fence_lost:/),","fenceHeld:true,"],
 ['lease flag derived',"leaseLost:any(/^lease_(lost|foreign):/),","leaseLost:false,"],
 ['probe flag derived',"probeComplete:!any(/^probe_incomplete:/)&&!any(/^(manifest|derived)_invalid:/),","probeComplete:true,"],
 ['probe flag covers the manifest',"&&!any(/^(manifest|derived)_invalid:/),",","],
 ['owner facts cap',"if(!Array.isArray(rows)||rows.length>OWNER_FACTS_CAP)","if(!Array.isArray(rows))"],
 ['run arguments',"return refused(['run_invalid']);","void 0;"],
];
const TARGETS=[
 {source:'src/film-person-baseline.js',test:'tests/film-person-cutover-record.mjs',variable:'BASELINE_RECORD_MODULE',mutants:RECORDER},
 {source:'scripts/film-person-cutover-run.mjs',test:'tests/film-person-cutover-run.mjs',variable:'CUTOVER_RUN_MODULE',mutants:RUN},
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutover-record-mutants-'));
assert.ok(path.relative(process.cwd(),dir).startsWith('..'),'the mutants are written outside the repository tree');
// A copy outside the tree keeps working: every relative import of the original becomes an absolute file URL.
const absolute=(text,from)=>text.replace(/(from\s*|import\()'(\.\.?\/[^']+)'/g,(_match,head,specifier)=>head+JSON.stringify(pathToFileURL(path.resolve(path.dirname(from),specifier)).href));
const run=(test,variable,file)=>new Promise(resolve=>{
 const child=spawn(process.execPath,[test],{env:{...process.env,[variable]:file},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>resolve({code,broken:/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError|does not provide an export/.test(err)?err.slice(0,300):null}));
});
try{
 const queue=[];
 for(const target of TARGETS){
  const original=fs.readFileSync(target.source,'utf8');
  for(const [name,from] of target.mutants)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+target.source);
  // the unmutated copy, moved the same way, must PASS: otherwise every mutant would be "killed" by the move itself
  const control=path.join(dir,path.basename(target.source,path.extname(target.source))+'.control.mjs');
  fs.writeFileSync(control,absolute(original,target.source));
  queue.push({name:'control '+target.source,test:target.test,variable:target.variable,file:control,control:true});
  target.mutants.forEach(([name,from,to],index)=>{
   const file=path.join(dir,path.basename(target.source,path.extname(target.source))+'.mutant'+index+'.mjs');
   fs.writeFileSync(file,absolute(original.replace(from,()=>to),target.source));
   queue.push({name,test:target.test,variable:target.variable,file});
  });
 }
 const survivors=[],broken=[];
 let killed=0;
 const workers=Array.from({length:Math.max(2,Math.min(8,os.availableParallelism()))},async()=>{
  while(queue.length){
   const item=queue.shift();
   const out=await run(item.test,item.variable,item.file);
   if(item.control){assert.equal(out.code,0,'the unmutated copy must pass: '+item.name+' '+(out.broken||''));continue;}
   if(out.broken)broken.push(item.name+': '+out.broken);
   else if(out.code===0)survivors.push(item.name);
   else killed++;
  }
 });
 await Promise.all(workers);
 assert.deepEqual(broken,[],'broken mutants (they do not parse or load, so they prove nothing)');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(killed,RECORDER.length+RUN.length);
 console.log('film-person-cutover-record-mutation: ok ('+RECORDER.length+' recorder mutants and '+RUN.length+' run mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.ok(!fs.existsSync(dir));
