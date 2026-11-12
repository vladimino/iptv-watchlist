// AIR-374 P1 / ADR 0117: mutation check of the projector's marker fence. Each mutant is a copy of ONE of the two sources (src/film-person-authority.js, the single
// source of the guard and the allowed states; src/d1-enrichment.js, the projector) with ONE guard removed or inverted; tests/projector-marker-fence.mjs, pointed at the
// mutant through PROJECTOR_AUTHORITY_SOURCE / PROJECTOR_SOURCE, must FAIL on it. A surviving mutant is a guard no test depends on.
// The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTHORITY='src/film-person-authority.js',PROJECTOR='src/d1-enrichment.js';
const sources={[AUTHORITY]:fs.readFileSync(AUTHORITY,'utf8'),[PROJECTOR]:fs.readFileSync(PROJECTOR,'utf8')};
const MUTANTS=[
 [AUTHORITY,'guard ignores the generation',"AND cutover='open' AND generation=?)\"","AND cutover='open' AND generation>=0 AND ?>=0)\""],
 [AUTHORITY,'guard ignores the mode',"WHERE id=1 AND mode=? AND cutover='open'","WHERE id=1 AND mode IS NOT NULL AND ?<>'' AND cutover='open'"],
 [AUTHORITY,'legacy guard always holds',"THEN 0 ELSE 1 END\"","THEN 1 ELSE 1 END\""],
 [AUTHORITY,'d1 is an allowed projector mode',"const PROJECTOR_MODES=['r2','prepared'];","const PROJECTOR_MODES=['r2','prepared','d1'];"],
 [AUTHORITY,'cutover is not checked',"||row.cutover!=='open')return null;","){}"],
 [AUTHORITY,'generation shape is not checked',"return Number.isInteger(generation)&&generation>=0?{mode:row.mode,cutover:'open',generation}:null;","return {mode:row.mode,cutover:'open',generation};"],
 [AUTHORITY,'a legacy expectation survives a readable table',"if(expected?.legacy===true)return false;\n const now","if(expected?.legacy===true)return true;\n const now"],
 [AUTHORITY,'holds ignores the generation',"&&now.mode===expected.mode&&now.generation===expected.generation;","&&now.mode===expected.mode;"],
 [PROJECTOR,'per-entity batches carry no guard',"await db.run(guard.sql,guard.params);",""],
 [PROJECTOR,'no refusal before the diff',"if(read.refused||(bulk&&read.expected.legacy)){","if(false){"],
 [PROJECTOR,'the grouped path accepts a legacy database',"if(read.refused||(bulk&&read.expected.legacy)){","if(read.refused){"],
 [PROJECTOR,'the run forgets the marker it read',"authority=read.expected;","authority={legacy:true};"],
 [PROJECTOR,'an unreadable marker counts as legacy',"  return {refused:true};\n }\n const expected","  return {expected:{legacy:true}};\n }\n const expected"],
 [PROJECTOR,'any read error counts as an absent table',"if(/no such table/i.test(String(error?.message||error)))return {expected:{legacy:true}};","return {expected:{legacy:true}};"],
 [PROJECTOR,'a refused batch is never told as a moved marker',"&&!await d1EnrichmentAuthorityHolds(db,authority)){try{error.fenceCause='authority';}catch{}throw error;}","&&false){try{error.fenceCause='authority';}catch{}throw error;}"],
 [PROJECTOR,'the marker is not read for a plain run',"if(mode==='on'){\n   const read=await d1EnrichmentReadAuthority(db);","if(mode==='on'&&bulk){\n   const read=await d1EnrichmentReadAuthority(db);"],
 [PROJECTOR,'the group cycle writes without its guard',"{sql:markerGuard.sql,params:markerGuard.params}];","{sql:'INSERT INTO projection_fence (held) SELECT 1',params:[]}];"],
];
for(const [file,name,from] of MUTANTS)assert.equal(sources[file].split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+file);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'projector-marker-fence-mutants-'));
// AIR-374: a mutant first runs only the numbered section of tests/projector-marker-fence.mjs that killed it when the hints were learned (HINTS: mutant name to section id); a mutant that passes that
// run is run against the WHOLE file before it is called a survivor, so a stale or wrong hint costs time and never hides a survivor. Every distinct lean run of the UNMUTATED test must pass too, or a
// lean run could "kill" for a reason of its own. FENCE_LEARN=1 runs every mutant whole and prints HINTS for the file.
const LEARN=process.env.FENCE_LEARN==='1';
const HINTS={
 "guard ignores the generation":"4",
 "guard ignores the mode":"4",
 "legacy guard always holds":"5",
 "d1 is an allowed projector mode":"1",
 "cutover is not checked":"1",
 "generation shape is not checked":"1",
 "a legacy expectation survives a readable table":"5",
 "holds ignores the generation":"4",
 "per-entity batches carry no guard":"2",
 "no refusal before the diff":"1",
 "the grouped path accepts a legacy database":"5",
 "the run forgets the marker it read":"2",
 "an unreadable marker counts as legacy":"1",
 "any read error counts as an absent table":"1",
 "a refused batch is never told as a moved marker":"4",
 "the marker is not read for a plain run":"1",
 "the group cycle writes without its guard":"4"
};
const learned={};
const run=(env,name)=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/projector-marker-fence.mjs'],{env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even parse or load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|TypeError/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));const seen=/LEAN_SECTION (\S+)/.exec(err);if(name&&code!==0&&seen)learned[name]=seen[1];resolve(code);});
});
try{
 const queue=MUTANTS.map(([file,name,from,to],index)=>{
  const mutant=path.join(dir,'mutant'+index+'.js');
  fs.writeFileSync(mutant,sources[file].replace(from,()=>to));
  return {name,env:file===AUTHORITY?{PROJECTOR_AUTHORITY_SOURCE:mutant}:{PROJECTOR_SOURCE:mutant}};
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const survivors=[];let fallbacks=0;
 for(const name of Object.keys(HINTS))assert.ok(MUTANTS.some(item=>item[1]===name),'a hint names no mutant: '+name);
 for(const section of new Set(Object.values(HINTS)))queue.unshift({control:{FENCE_ONLY:section}});
 const workers=Array.from({length:4},async()=>{while(queue.length){
  const item=queue.shift();
  if(item.control){assert.equal(await run(item.control),0,'the unmutated test passes with '+JSON.stringify(item.control));continue;}
  const hint=LEARN?undefined:HINTS[item.name];
  let code=hint?await run({...item.env,FENCE_ONLY:hint},item.name):0;
  if(code===0){if(hint)fallbacks++;code=await run(item.env,item.name);}
  if(code===0)survivors.push(item.name);
 }});
 await Promise.all(workers);
 if(LEARN)console.log('const HINTS='+JSON.stringify(Object.fromEntries(MUTANTS.map(item=>[item[1],learned[item[1]]]).filter(entry=>entry[1])),null,1)+';');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('projector-marker-fence-mutation: ok ('+MUTANTS.length+' mutants killed'+(fallbacks?', '+fallbacks+' needed the whole file: refresh HINTS with FENCE_LEARN=1':'')+')');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
