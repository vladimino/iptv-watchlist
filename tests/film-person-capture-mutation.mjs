// AIR-373 stage B: mutation check of every guard of scripts/film-person-capture.mjs. Each mutant is a copy of the module with ONE guard removed; the capture test
// (tests/film-person-capture.mjs, pointed at the mutant through CAPTURE_MODULE) must FAIL on it. A mutant that survives means a guard no test depends on.
// AIR-418: the last element of a mutant is the section of the capture test that kills it (CAPTURE_SECTIONS), so a mutant costs one section and not the whole
// file. The number is only where to look first: a mutant that passes its section is run against the WHOLE file before it is called a survivor, so a stale
// number costs time and never hides a survivor.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const original=fs.readFileSync('scripts/film-person-capture.mjs','utf8');
const MUTANTS=[
 ['allowlist check',"if(!isAllowed(key,runIdOf()))throw capError('key_not_allowlisted');",'',2],
 ['read-only guard',"text=assertReadOnly(sql);","text=sql;",12],
 ['second HEAD compare',"if(!second||second.etag!==first.etag||second.size!==first.size)return {reason:'etag_changed:'+item.id};",'',8],
 ['final ETag recheck',"reasons.push('etag_changed_after:'+entry.id);","void 0;",7],
 ['marker moved',"['marker','marker_moved'],",'',18],
 ['baseline moved',"['baseline','baseline_moved'],",'',11],
 ['discovery generation moved',"['discovery','discovery_generation_moved'],",'',11],
 ['foreign lease',"if(gate.lease.held)reasons.push('projector_lease_live');",'',19],
 ['live window',"if(gate.window.live)reasons.push('window_live');",'',16],
 ['witness',"if(stable(witness0)!==stable(witness1))reasons.push('witness_moved');",'',11],
 ['size cap',"if(first.size>maxBytes)return {reason:'size_cap:'+item.id};",'',4],
 ['total size cap',"if(total>maxTotalBytes){reasons.push('size_cap:total');break;}",'',4],
 ['missing required',"return item.required?{reason:'missing:'+item.id}:","return false?{reason:'missing:'+item.id}:",13],
 ['shape check',"if(!SHAPES[item.shape](value))return {reason:'malformed:'+item.id};",'',10],
 ['writer fence',"reasons.push(...(result.value?fenceRefusals(item,result.value,Date.parse(now())):[]));",'',21],
 ['checkpoint ETag check',"if(entry.state==='present'?(!current||current.etag!==entry.etag||current.size!==entry.size):current!==null){ok=false;break;}",'',14],
 ['checkpoint gate check',"stable(checkpoint.gate)===stable(gate0)&&",'',14],
 ['manifest digest',"if(sha(stable(core))!==digest)reasons.push('manifest_digest');",'',3],
 ['object digest',"reasons.push('object_digest:'+entry.id)","void 0",3],
 ['ETag after the cut',"reasons.push('etag_changed_after_cut:'+entry.id);","void 0;",18],
 ['identity before the cut',"if(moved0.length)return {ok:false,reasons:moved0};",'',21],
 ['identity after the cut',"if(moved1.length)return {ok:false,reasons:moved1};",'',21],
 ['identity compares leaves',"if(a.get(key)!==b.get(key))reasons.push(","if(false)reasons.push(",21],
 ['identity field list',"const IDENTITY_FIELDS=['schema','marker','fence','baseline','discovery','published','owner'];","const IDENTITY_FIELDS=['schema','marker','fence','baseline','discovery','published'];",21],
 ['live lease before the cut',"if(fresh0.lease.held)moved0.push('projector_lease_live');",'',18],
 ['live window before the cut',"if(fresh0.window.live)moved0.push('window_live');",'',21],
 ['derived verification',"if(unbound.length)return {ok:false,reasons:unbound.map(item=>'derived_invalid:'+item)};",'',21],
 ['derived digest',"if(digest!==recorded[id].sha256)reasons.push('derived_digest:'+id);",'',1],
 ['derived missing',"reasons.push('derived_missing:'+id);continue;","continue;",1],
 ['derived extra',"if(!(id in recorded))reasons.push('derived_extra:'+id);",'',21],
 ['derived published identity',"if(id==='publishedEpg'&&(value.generation!==recorded[id].generation||","if(false&&(value.generation!==recorded[id].generation||",1],
 ['derived owner identity',"if(id==='ownerReviews'&&(recorded[id].generation!==after?.owner?.generation))reasons.push('derived_identity:'+id);",'',1],
 ['derived route match',"if(!!routed[id]!==(id in recorded))reasons.push('derived_route_mismatch:'+id);",'',1],
 ['diagnostics witness',"diagnostics.stable=!!witnessA&&!!witnessB&&stable(witnessA)===stable(witnessB);","diagnostics.stable=true;",21],
 ['diagnostics cut label',"diagnostics={cut:'separate_observation',","diagnostics={cut:'same_cut',",21],
 ['source verified',"verified:false,kind:'projector-input-capture'","verified:true,kind:'projector-input-capture'",18],
 ['D1 derived R2 guard',"get:async key=>{throw capError('r2_read_in_d1_derived',key);}","get:async key=>null",11],
];
for(const [name,from,to,section] of MUTANTS){assert.ok(Number.isInteger(section)&&section>=1,'the section of "'+name+'"');assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in the module');}
const run=(file,section=null)=>new Promise(resolve=>{
 const env={...process.env,CAPTURE_MODULE:pathToFileURL(file).href};delete env.CAPTURE_SECTIONS;if(section)env.CAPTURE_SECTIONS=String(section);
 const child=spawn(process.execPath,['tests/film-person-capture.mjs'],{env,stdio:'ignore'});
 child.on('exit',code=>resolve(code));
});
const survivors=[],files=[];let fullRuns=0;
try{
 const queue=MUTANTS.map(([name,from,to,section],index)=>{const file=path.resolve('scripts/.film-person-capture.mutant'+index+'.mjs');fs.writeFileSync(file,original.replace(from,()=>to));files.push(file);return {name,file,section};});
 // A small worker pool (not batches that wait for their slowest member): at most `width` capture tests run at once, each takes the next mutant when it ends.
 const width=4;let next=0;
 await Promise.all(Array.from({length:width},async()=>{
  while(next<queue.length){
   const item=queue[next++];
   if(await run(item.file,item.section)!==0)continue;
   // not killed by its section: the whole file decides
   fullRuns++;
   if(await run(item.file)===0)survivors.push(item.name);
  }
 }));
 survivors.sort();
}finally{for(const file of files)fs.rmSync(file,{force:true});}
assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
console.log('film-person-capture-mutation: ok ('+MUTANTS.length+' mutants killed'+(fullRuns?', '+fullRuns+' needed the whole file: update their section':'')+')');
