// AIR-373: mutation check of the guards of src/film-person-cutover-minimum.js. Each mutant is a copy of the module with ONE guard removed or inverted; the gate test
// (tests/film-person-cutover-minimum.mjs, pointed at the mutant through CUTOVER_MODULE) must FAIL on it. A surviving mutant is a guard no test depends on.
// The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const original=fs.readFileSync('src/film-person-cutover-minimum.js','utf8');
const MUTANTS=[
 ['ledger version',"if(!ledger||ledger.version!==LEDGER_VERSION){reasons.push('ledger_version');return done();}",''],
 ['section required',"if(!cm||cm.version!==CUTOVER_MINIMUM_VERSION){reasons.push('cutover_minimum_missing');return done();}",''],
 ['inputs complete',"if(cm.inputsComplete!==true)reasons.push('incomplete');",''],
 ['builder inputs complete',"const inputsComplete=actual?.complete!==false&&expected?.complete!==false;","const inputsComplete=true;"],
 ['read consistent',"if(ledger.readConsistent!==true)reasons.push('inconsistent_read');",''],
 ['class unavailable flag',"if(!entry||entry.unavailable){","if(!entry){"],
 ['class present',"if(!entry||entry.unavailable){reasons.push('class_unavailable:'+name);continue;}",''],
 ['class unexplained',"if(entry.unexplained?.total!==0)reasons.push('unexplained:'+name);",''],
 ['total unexplained',"if(ledger.totals?.unexplained!==0)reasons.push('unexplained_total');",''],
 ['required classes exclude only ownerLink',".filter(name=>name!=='ownerLink')",''],
 ['source verified flag',"ledger.source.verified===true&&",''],
 ['source digest shape',"&&hex(ledger.source.aggregateSha256)))reasons.push('source_unverified');","))reasons.push('source_unverified');"],
 ['source unverified',"reasons.push('source_unverified');","void 0;"],
 ['manifest binding',"if(s.manifestDigest!==ledger.source?.aggregateSha256||!hex(s.manifestDigest))reasons.push('source_manifest_mismatch');",''],
 ['ETags present',"reasons.push('r2_etags_missing');","void 0;"],
 ['ETags unchanged',"else if(s.r2Etags.before!==s.r2Etags.after)reasons.push('r2_etags_changed');",''],
 ['D1 identity',"if(!same(s.d1?.before,s.d1?.after))reasons.push('d1_identity_changed');",''],
 ['identity must be present',"const same=(a,b)=>present(a)&&present(b)&&stable(a)===stable(b);","const same=(a,b)=>stable(a)===stable(b);"],
 ['witness',"if(!same(s.witness?.before,s.witness?.after))reasons.push('witness_moved');",''],
 ['fence held',"if(s.fenceHeld!==true||s.leaseLost!==false)","if(s.leaseLost!==false)"],
 ['lease lost',"if(s.fenceHeld!==true||s.leaseLost!==false)","if(s.fenceHeld!==true)"],
 ['probe complete',"if(s.probeComplete!==true)reasons.push('probe_incomplete');",''],
 ['builder fence default',"fenceHeld:evidence.fenceHeld===true,","fenceHeld:true,"],
 ['builder lease default',"leaseLost:evidence.leaseLost!==false,","leaseLost:false,"],
 ['builder probe default',"probeComplete:evidence.probeComplete===true,","probeComplete:true,"],
 ['ownerLink class',"if(o.unavailable||!o.keys)reasons.push('class_unavailable:ownerLink');","if(false)reasons.push('class_unavailable:ownerLink');"],
 ['builder ownerLink unavailable',"||(actual?.unavailable||[]).includes('ownerLink');",';'],
 ['owner-review authority',"reasons.push('owner_review_authority_not_d1');","void 0;"],
 ['owner-review authority mode',"o.authority?.mode==='d1'&&",''],
 ['owner-review facts present',"reasons.push('owner_review_facts_missing');","void 0;"],
 ['owner-review facts unchanged',"if(stable(before)!==stable(after))reasons.push('owner_review_facts_changed');",''],
 ['owner-review count',"if(after.count!==o.keys.count)reasons.push('owner_review_count_mismatch');",''],
 ['owner-review key missing',"if(o.expected.missing!==0)reasons.push('owner_review_key_missing');",''],
 ['owner-review key extra',"if(o.expected.extra!==0)reasons.push('owner_review_key_extra');",''],
 ['owner-review key digest',"if(o.expected.digest!==o.keys.digest)reasons.push('owner_review_key_digest');",''],
 ['builder missing keys',"missing:[...e].filter(key=>!a.has(key)).length","missing:0"],
 ['builder extra keys',"extra:[...a].filter(key=>!e.has(key)).length","extra:0"],
 ['not-proved source parity note',"if(!cm?.ownerLink?.expected)out.push('owner_review_keys_not_source_parity');",''],
 ['waiver pin',"&&stable(item)===stable(OWNER_LINK_WAIVER);",";"],
 ['waiver pinned id',"id:'AIR-373-owner-link-values-2026-11-10',","id:'any',"],
 ['waiver pinned scope',"scope:'link_values',approver","scope:'any',approver"],
 ['waiver pinned class',"class:'ownerLink',scope","class:'any',scope"],
 ['waiver pinned approver',"approver:'owner'})","approver:'any'})"],
 ['waiver pinned decision',"decision:'AIR-373 owner decision of 2026-11-10',","decision:'any',"],
 ['waiver not permitted',"if(!waiverMatches(item))reasons.push('waiver_not_permitted:'+index);",''],
 ['waiver required',"if(good===0)reasons.push('waiver_missing:ownerLink/link_values');",''],
 ['waiver duplicate',"if(good>1)reasons.push('waiver_duplicate');",''],
 ['accepted only on pass',"accepted:reasons.length===0?acceptedOf(cm?.waivers):[]","accepted:acceptedOf(cm?.waivers)"],
 ['accepted derived',"if(stable(cm.accepted)!==stable(acceptedOf(waivers)))reasons.push('accepted_mismatch');",''],
 ['notProved derived',"if(stable(cm.notProved)!==stable(notProvedOf(cm)))reasons.push('not_proved_mismatch');",''],
 ['strict digest',"reasons.push('digest_mismatch');","void 0;"],
 ['cutover digest',"reasons.push('cutover_digest_mismatch');","void 0;"],
 ['cutover digest covers the section',"cutoverMinimum:ledger.cutoverMinimum}","cutoverMinimum:null}"],
];
for(const [name,from,to] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in the module');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutover-minimum-mutants-'));
const baseline=pathToFileURL(path.resolve('src/film-person-baseline.js')).href;
const run=file=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-cutover-minimum.mjs'],{env:{...process.env,CUTOVER_MODULE:file},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even parse or load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError/.test(err),'broken mutant '+file+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=MUTANTS.map(([name,from,to],index)=>{
  const file=path.join(dir,'mutant'+index+'.mjs');
  fs.writeFileSync(file,original.replace(from,()=>to).replace("'./film-person-baseline.js'",JSON.stringify(baseline)));
  return {name,file};
 });
 const survivors=[];
 const workers=Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.file)===0)survivors.push(item.name);}});
 await Promise.all(workers);
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('film-person-cutover-minimum-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
