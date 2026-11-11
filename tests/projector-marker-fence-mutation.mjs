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
const run=(env)=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/projector-marker-fence.mjs'],{env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even parse or load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|TypeError/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=MUTANTS.map(([file,name,from,to],index)=>{
  const mutant=path.join(dir,'mutant'+index+'.js');
  fs.writeFileSync(mutant,sources[file].replace(from,()=>to));
  return {name,env:file===AUTHORITY?{PROJECTOR_AUTHORITY_SOURCE:mutant}:{PROJECTOR_SOURCE:mutant}};
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const survivors=[];
 const workers=Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.env)===0)survivors.push(item.name);}});
 await Promise.all(workers);
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('projector-marker-fence-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
