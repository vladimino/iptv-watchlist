// AIR-374 P6 (offline): mutation check of the differential harness and the computed handoffReadiness. Three kinds of mutant, each must make its target test FAIL:
//  1. a deliberately UNCLASSIFIED difference injected into a scenario (DIFFERENTIAL_INJECT) fails tests/canonical-differential.mjs: an unclassified difference never passes;
//  2. a copy of src/canonical-differential-registry.js with one claim wrong (a scenario that did not run, a table not compared, an unproven exception, a gap that was
//     renamed) fails the harness: the registry cannot say more than the harness proved;
//  3. a copy of src/canonical-producers.js with ONE readiness rule removed or inverted fails tests/canonical-handoff-readiness.mjs (PRODUCERS_SOURCE).
// A surviving mutant is a rule no test depends on. Mutants live OUTSIDE the repository tree (a temporary directory, removed afterwards), with the relative imports turned into
// absolute file URLs; they run four at a time and every target test takes about a second.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {root as helperRoot,template} from './canonical-differential-helper.mjs';
const REGISTRY='src/canonical-differential-registry.js',PRODUCERS='src/canonical-producers.js';
const registry=fs.readFileSync(REGISTRY,'utf8'),producers=fs.readFileSync(PRODUCERS,'utf8');
const REGISTRY_MUTANTS=[
 ['a coverage entry names a scenario that never ran',"['first_write','normal_refresh'],['film_metadata']","['first_write','no_such_scenario'],['film_metadata']"],
 ['a coverage entry claims a table the harness does not compare',"['localization_conflict_rows'],['localization_conflict']","['localization_conflict_rows'],['localization_conflict','canonical_revision']"],
 ['a coverage entry claims a table its scenarios never fill',"['first_write','normal_refresh'],['film_metadata']","['first_write','normal_refresh'],['film_metadata','film_redirect']"],
 ['a former gap is renamed in the registry',"cover('film_sync_state clocks'","cover('film_sync_state clocks and more'"],
 ['an exception nothing exercises is registered',"{id:'credit_ordinals_kept'","{id:'never_met_anywhere',status:'draft',area:'x',rule:'x'},\n {id:'credit_ordinals_kept'"],
 ['an exception the harness meets is dropped',"{id:'credit_ordinals_kept',status:'accepted',area:'film_person_credit.ordinal',rule:'The projector renumbers ordinals from its source; the canonical writers keep an existing ordinal and append a new credit after the highest of its role.'},",""],
 ['a coverage entry has no writer',"cover('film_sync_state clocks',['writeFilmFacts']","cover('film_sync_state clocks',[]"],
];
const PRODUCER_MUTANTS=[
 ['an unmoved freeze reader does not block',"if(item.class==='freeze'){if(item.moved!==true)blockers.push","if(item.class==='freeze'){if(false)blockers.push"],
 ['an exception reader marked moved does not block',"else if(item.class==='exception'){if(item.moved===true)blockers.push","else if(item.class==='exception'){if(false)blockers.push"],
 ['an exception reader blocks while unmoved',"if(item.moved===true)blockers.push('reader_exception_marked_moved:'","if(item.moved!==true)blockers.push('reader_exception_marked_moved:'"],
 ['an unknown reader class does not block',"else blockers.push('reader_class_invalid:'+item.name);","else{}"],
 ['a reader registry is duplicated in the producers',"readers=evidence.readers||CANONICAL_READER_REGISTRY","readers=evidence.readers||[{name:'x',class:'freeze',moved:true}]"],
 ['a schema read error is not named',"}catch{blockers.push('schema_unreadable');}","}catch{}"],
 ['a missing projection_run counts as a free lease',"if(!tables.has('projection_run'))throw new Error('projection_run absent');",""],
 ['a lease read error counts as a free lease',"}catch{blockers.push('projector_lease_unreadable');}","}catch{}"],
 ['a window read error counts as idle',"}catch{blockers.push('projector_window_unreadable');}","}catch{}"],
 ['a missing window row counts as idle',"if(!window||!['idle','requested','held'].includes(window.state))throw","if(false)throw"],
 ['an absent window table is not idle',"if(tables.has('projector_window')||!schemaOk){","if(true){"],
 ['a receipt read error is not named',"}catch{blockers.push('receipts_unreadable');}","}catch{}"],
 ['an unparseable clock is accepted',"if(!Number.isFinite(nowMs))blockers.push('now_invalid');",""],
 ['a failed schema read still checks receipts',"if(!db||!schemaOk)blockers.push(db?'receipts_unreadable':'receipts_schema_missing');\n else if","if(false)blockers.push('x');\n else if"],
 ['a gap is cleared without its writers being registered',"entry.writers.every(name=>typeof calls.CALLS[name]==='function'&&!!calls.RECONCILE[name])","true"],
 ['a gap is cleared though the registry does not mark it covered',"entry.covered===true&&","true&&"],
 ['a gap is cleared with no scenario',"&&entry.scenarios?.length>0&&entry.tables?.length>0;","&&true;"],
 ['a gap with no entry counts as cleared',"const registered=!!entry&&","const registered=!entry||"],
 ['cleared and open gaps are swapped',"(registered?cleared:open).push(gap);","(registered?open:cleared).push(gap);"],
 ['a named difference that is not accepted does not block',"if(item.status!=='accepted')blockers.push('exception_not_accepted:'","if(false)blockers.push('exception_not_accepted:'"],
 ['too many rows in a class do not block',"if(found!==item.expected)blockers.push","if(found<item.expected)blockers.push"],
 ['too few rows in a class do not block',"if(found!==item.expected)blockers.push","if(found>item.expected)blockers.push"],
 ['an unreadable class table does not block',"{blockers.push('empty_class_unreadable:'+item.name);continue;}","{continue;}"],
 ['a live projector lease does not block',"if(lease)blockers.push('projector_lease_live');","if(false)blockers.push('projector_lease_live');"],
 ['a requested projector window does not block',"window.state!=='idle'&&!(Number(window.expires_at)<=nowMs)","window.state==='held'&&!(Number(window.expires_at)<=nowMs)"],
 ['an expired projector window blocks',"window.state!=='idle'&&!(Number(window.expires_at)<=nowMs)","window.state!=='idle'"],
 ['the marker state is not checked',"if(gate.state!=='prepared')blockers.push","if(false)blockers.push"],
 ['the baseline is not checked',"if(gate.baseline!=='verified')blockers.push","if(false)blockers.push"],
 ['ready ignores the blockers',"return {ready:blockers.length===0,","return {ready:true,"],
 ['a missing receipt schema does not block',"else if(version<RECEIPT_MIN_VERSION||!tables.has(RECEIPTS_PROTOCOL.table)||!tables.has('canonical_receipt_baseline_seal'))blockers.push('receipts_schema_missing');","else if(false)blockers.push('receipts_schema_missing');"],
 ['a missing baseline after the flip does not block',"if(sealed!==1){if(gate&&['open','held'].includes(gate.state))blockers.push('receipts_baseline_missing');}","if(sealed!==1){}"],
 ['a missing baseline blocks before the flip',"if(gate&&['open','held'].includes(gate.state))blockers.push('receipts_baseline_missing')","if(true)blockers.push('receipts_baseline_missing')"],
 ['an unverified baseline does not block',"if(!(await verifyBaseline(env)).ok)blockers.push","if(false)blockers.push"],
 ['unreceipted changes do not block',"if((await readUnreceipted(env)).unreceipted.length)blockers.push","if(false)blockers.push"],
 ['an open attention receipt does not block',"if((await listAttention(env)).length)blockers.push","if(false)blockers.push"],
 ['an unregistered receipts protocol does not block',"if(![...operations.values()].some(spec=>spec.atomic===true))blockers.push","if(false)blockers.push"],
 ['a non-atomic operation registers the protocol',"some(spec=>spec.atomic===true))blockers.push('receipts_protocol_unregistered')","some(spec=>true))blockers.push('receipts_protocol_unregistered')"],
 ['a non-atomic operation wires a producer',"spec.operation===kind&&spec.atomic===true","spec.operation===kind"],
 ['an unwired producer does not block',"for(const item of wiring)if(!item.requires.every(","for(const item of wiring)if(false&&!item.requires.every("],
 ['a producer is wired by one of its kinds',"item.requires.every(kind=>OPERATION_KINDS","item.requires.some(kind=>OPERATION_KINDS"],
 ['a producer no longer needs the person kind',"requires:Object.freeze(['film_mutation','person_mutation','film_metadata','film_dimension','film_sync_state','film_membership','person_state'])","requires:Object.freeze(['film_mutation','film_metadata','film_dimension','film_sync_state','film_membership','person_state'])"],
 ['the accepted class count is changed',"table:'film_rated_admission',expected:708","table:'film_rated_admission',expected:707"],
];
// Each readiness mutant is first run against only the section of tests/canonical-handoff-readiness.mjs that should kill it (READINESS_ONLY). A mutant the hinted section does
// not kill is run again against the WHOLE file, so a stale hint can never hide a survivor; the hint only saves time.
const HINTS={
 'a schema read error is not named':'3g','a missing projection_run counts as a free lease':'3g','a lease read error counts as a free lease':'3g','a window read error counts as idle':'3g','a missing window row counts as idle':'3g','an absent window table is not idle':'3g','a receipt read error is not named':'3g','an unparseable clock is accepted':'3g','a failed schema read still checks receipts':'3g',
 'a gap is cleared without its writers being registered':'3e','a gap is cleared though the registry does not mark it covered':'3e','a gap is cleared with no scenario':'3e','a gap with no entry counts as cleared':'3e','cleared and open gaps are swapped':'1',
 'a named difference that is not accepted does not block':'3f','a missing receipt schema does not block':'3b','a missing baseline after the flip does not block':'3a','a missing baseline blocks before the flip':'1','an unverified baseline does not block':'3b',
 'unreceipted changes do not block':'3b','an open attention receipt does not block':'3b','an unregistered receipts protocol does not block':'3b','a non-atomic operation registers the protocol':'3b','a non-atomic operation wires a producer':'3b','an unwired producer does not block':'3b',
 'a producer is wired by one of its kinds':'3b','a producer no longer needs the person kind':'3b',
 'too many rows in a class do not block':'3d','too few rows in a class do not block':'3d','an unreadable class table does not block':'3d',
 'a live projector lease does not block':'3a','a requested projector window does not block':'3a','an expired projector window blocks':'3a','the marker state is not checked':'3a','the baseline is not checked':'3a','ready ignores the blockers':'3a',
 'an unmoved freeze reader does not block':'3c','an exception reader marked moved does not block':'3c','an exception reader blocks while unmoved':'3c','an unknown reader class does not block':'3c','a reader registry is duplicated in the producers':'2','the accepted class count is changed':'2',
};
for(const [name,from] of REGISTRY_MUTANTS)assert.equal(registry.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+REGISTRY);
for(const [name,from] of PRODUCER_MUTANTS)assert.ok(producers.split(from).length>=2,'the mutation text of "'+name+'" must occur in '+PRODUCERS);
for(const [name,from] of PRODUCER_MUTANTS)assert.equal(producers.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+PRODUCERS);
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'differential-mutants-'));
const shared=template();
const absolute=(text,base)=>text.replace(/from '\.\/([^']+)'/g,(_,file)=>"from '"+pathToFileURL(path.resolve(base,file)).href+"'");
const run=(test,env)=>new Promise(resolve=>{
 const child=spawn(process.execPath,[test],{env:{...process.env,TMPDIR:dir,DIFFERENTIAL_TEMPLATE:shared,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=[];
 // 1. injected unclassified differences, in an IDENTICAL-looking scenario and in a refresh
 for(const id of ['normal_refresh','localization_conflict_rows'])queue.push({name:'an unclassified difference injected into '+id,test:'tests/canonical-differential.mjs',env:{DIFFERENTIAL_INJECT:id}});
 REGISTRY_MUTANTS.forEach(([name,from,to],index)=>{const file=path.join(dir,'registry'+index+'.mjs');fs.writeFileSync(file,absolute(registry,'src').replace(from,()=>to));queue.push({name,test:'tests/canonical-differential.mjs',env:{DIFFERENTIAL_REGISTRY_SOURCE:file}});});
 PRODUCER_MUTANTS.forEach(([name,from,to],index)=>{const file=path.join(dir,'producers'+index+'.mjs');fs.writeFileSync(file,absolute(producers,'src').replace(from,()=>to));queue.push({name,test:'tests/canonical-handoff-readiness.mjs',env:{PRODUCERS_SOURCE:file},hint:HINTS[name]?{READINESS_ONLY:HINTS[name]}:null});});
 const total=queue.length;
 assert.equal(await run('tests/canonical-differential.mjs',{}),0,'the unmutated harness passes');
 assert.equal(await run('tests/canonical-handoff-readiness.mjs',{}),0,'the unmutated readiness test passes');
 const survivors=[];
 await Promise.all(Array.from({length:Math.min(4,Math.max(2,os.cpus().length))},async()=>{while(queue.length){const item=queue.shift();{const first=await run(item.test,{...item.env,...(item.hint||{})});if(first===0&&(!item.hint||await run(item.test,item.env)===0))survivors.push(item.name);}}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-differential-mutation: ok ('+total+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(helperRoot,{recursive:true,force:true});}
