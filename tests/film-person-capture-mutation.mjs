// AIR-373 stage B: mutation check of every guard of scripts/film-person-capture.mjs. Each mutant is a copy of the module with ONE guard removed; the capture test
// (tests/film-person-capture.mjs, pointed at the mutant through CAPTURE_MODULE) must FAIL on it. A mutant that survives means a guard no test depends on.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const original=fs.readFileSync('scripts/film-person-capture.mjs','utf8');
const MUTANTS=[
 ['allowlist check',"if(!isAllowed(key,runIdOf()))throw capError('key_not_allowlisted');",''],
 ['read-only guard',"text=assertReadOnly(sql);","text=sql;"],
 ['second HEAD compare',"if(!second||second.etag!==first.etag||second.size!==first.size)return {reason:'etag_changed:'+item.id};",''],
 ['final ETag recheck',"reasons.push('etag_changed_after:'+entry.id);","void 0;"],
 ['marker moved',"['marker','marker_moved'],",''],
 ['baseline moved',"['baseline','baseline_moved'],",''],
 ['discovery generation moved',"['discovery','discovery_generation_moved'],",''],
 ['foreign lease',"if(gate.lease.held)reasons.push('projector_lease_live');",''],
 ['live window',"if(gate.window.live)reasons.push('window_live');",''],
 ['witness',"if(stable(witness0)!==stable(witness1))reasons.push('witness_moved');",''],
 ['size cap',"if(first.size>maxBytes)return {reason:'size_cap:'+item.id};",''],
 ['total size cap',"if(total>maxTotalBytes){reasons.push('size_cap:total');break;}",''],
 ['missing required',"return item.required?{reason:'missing:'+item.id}:","return false?{reason:'missing:'+item.id}:"],
 ['shape check',"if(!SHAPES[item.shape](value))return {reason:'malformed:'+item.id};",''],
 ['writer fence',"reasons.push(...(result.value?fenceRefusals(item,result.value,Date.parse(now())):[]));",''],
 ['checkpoint ETag check',"if(entry.state==='present'?(!current||current.etag!==entry.etag||current.size!==entry.size):current!==null){ok=false;break;}",''],
 ['checkpoint gate check',"stable(checkpoint.gate)===stable(gate0)&&",''],
 ['manifest digest',"if(sha(stable(core))!==digest)reasons.push('manifest_digest');",''],
 ['object digest',"reasons.push('object_digest:'+entry.id)","void 0"],
 ['ETag after the cut',"reasons.push('etag_changed_after_cut:'+entry.id);","void 0;"],
 ['identity before the cut',"if(moved0.length)return {ok:false,reasons:moved0};",''],
 ['identity after the cut',"if(moved1.length)return {ok:false,reasons:moved1};",''],
 ['identity compares leaves',"if(a.get(key)!==b.get(key))reasons.push(","if(false)reasons.push("],
 ['identity field list',"const IDENTITY_FIELDS=['schema','marker','fence','baseline','discovery','published','owner'];","const IDENTITY_FIELDS=['schema','marker','fence','baseline','discovery','published'];"],
 ['live lease before the cut',"if(fresh0.lease.held)moved0.push('projector_lease_live');",''],
 ['live window before the cut',"if(fresh0.window.live)moved0.push('window_live');",''],
 ['derived verification',"if(unbound.length)return {ok:false,reasons:unbound.map(item=>'derived_invalid:'+item)};",''],
 ['derived digest',"if(digest!==recorded[id].sha256)reasons.push('derived_digest:'+id);",''],
 ['derived missing',"reasons.push('derived_missing:'+id);continue;","continue;"],
 ['derived extra',"if(!(id in recorded))reasons.push('derived_extra:'+id);",''],
 ['derived published identity',"if(id==='publishedEpg'&&(value.generation!==recorded[id].generation||","if(false&&(value.generation!==recorded[id].generation||"],
 ['derived owner identity',"if(id==='ownerReviews'&&(recorded[id].generation!==after?.owner?.generation))reasons.push('derived_identity:'+id);",''],
 ['derived route match',"if(!!routed[id]!==(id in recorded))reasons.push('derived_route_mismatch:'+id);",''],
 ['diagnostics witness',"diagnostics.stable=!!witnessA&&!!witnessB&&stable(witnessA)===stable(witnessB);","diagnostics.stable=true;"],
 ['diagnostics cut label',"diagnostics={cut:'separate_observation',","diagnostics={cut:'same_cut',"],
 ['source verified',"verified:false,kind:'projector-input-capture'","verified:true,kind:'projector-input-capture'"],
 ['D1 derived R2 guard',"get:async key=>{throw capError('r2_read_in_d1_derived',key);}","get:async key=>null"],
];
for(const [name,from,to] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in the module');
const run=(file)=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-capture.mjs'],{env:{...process.env,CAPTURE_MODULE:pathToFileURL(file).href},stdio:'ignore'});
 child.on('exit',code=>resolve(code));
});
const survivors=[],files=[];
try{
 const queue=MUTANTS.map(([name,from,to],index)=>{const file=path.resolve('scripts/.film-person-capture.mutant'+index+'.mjs');fs.writeFileSync(file,original.replace(from,()=>to));files.push(file);return {name,file};});
 const width=4;
 for(let at=0;at<queue.length;at+=width){
  const batch=queue.slice(at,at+width);
  const codes=await Promise.all(batch.map(item=>run(item.file)));
  batch.forEach((item,index)=>{if(codes[index]===0)survivors.push(item.name);});
 }
}finally{for(const file of files)fs.rmSync(file,{force:true});}
assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
console.log('film-person-capture-mutation: ok ('+MUTANTS.length+' mutants killed)');
