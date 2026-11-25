// AIR-662 / ADR 0218 D1: mutation check of the projection-aware localization writer. Each mutant is a copy of src/film-localization-projection.js with ONE
// safety rule removed or inverted; tests/film-localization-projection.mjs, pointed at the mutant through FILM_PROJECTION_MODULE, must FAIL on it.
// Mutants are written OUTSIDE the repository tree (a temporary directory, removed afterwards), with the relative imports turned into absolute file URLs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const SOURCE='src/film-localization-projection.js';
const source=fs.readFileSync(SOURCE,'utf8');
const MUTANTS=[
 ['the owner-review token is not asserted in the batch',' statements.push(...ownerTokenStatements(token));\n',''],
 ['a moved owner token is not named',"if(again.digest!==token.digest)throw failed('localization_owner_moved',error);",''],
 ['verified owner values are ignored','effective=owners.length?resolveLocalization({owner:{value:owners[0]}}):ROW.effective(snapshot,write);','effective=ROW.effective(snapshot,write);'],
 ['conflicting owner values choose one','if(owners.length>1){','if(false){'],
 ['redirect ancestors are not owner links','links.push(row.from_id);frontier.push(row.from_id);',''],
 ['a non-authoritative owner domain is trusted',"if(!marker||marker.mode!=='d1'||(marker.writes!=='open'&&marker.writes!=='held'))","if(!marker)"],
 ['the projection is not materialised',"else if(!ROW.same(row,params)){changes.push('dimension:localization');statements.push([ROW.upsert(),params]);}",''],
 ['a reviewed row is not held in code','if(ROW.strong(row))skipped.push','if(false)skipped.push'],
 ['a replay with other content is accepted',"throw failed('localization_replay_mismatch');","skipped.push({field:'source:'+item.source,reason:'replay'});continue;"],
 ['an older observation is written','if(row&&!(observedAt>row.observed_at)){skipped.push','if(false){skipped.push'],
 ['a no-op opens a batch','if(plan.noop)return {id,revision:snapshot.revision,written:false','if(false)return {id,revision:snapshot.revision,written:false'],
 ['an absent Film reaches the batch',"if(!snapshot.film)throw failed('film_person_precondition');\n const token",'const token'],
];
for(const [name,from] of MUTANTS)assert.equal(source.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+SOURCE);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'film-projection-mutants-'));
const absolute=text=>text.replace(/from '\.\/([^']+)'/g,(_,file)=>"from '"+pathToFileURL(path.resolve('src',file)).href+"'");
const run=env=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-localization-projection.mjs'],{env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const control=path.join(dir,'control.mjs');
 fs.writeFileSync(control,absolute(source));
 assert.equal(await run({FILM_PROJECTION_MODULE:control}),0,'the unmutated copy passes');
 const queue=MUTANTS.map(([name,from,to],index)=>{
  const file=path.join(dir,'mutant'+index+'.mjs');
  fs.writeFileSync(file,absolute(source).replace(from,()=>to));
  return {name,env:{FILM_PROJECTION_MODULE:file}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.env)===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('film-localization-projection-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
