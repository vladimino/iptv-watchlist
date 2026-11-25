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
 ['the generation of a consumed row is not asserted',"AND generation<>?)`),[...token.links,token.generation]]);","AND 0)`),[...token.links,token.generation]]);"],
 ['the redirect closure is not asserted',"out.push([fenced.assertSql(`NOT EXISTS (SELECT 1 FROM film_redirect WHERE to_film_id IN (${marks(token.links)}) AND from_id NOT IN (${marks(token.links)}))`),[...token.links,...token.links]]);",''],
 ['an ancestor leaving the closure is not asserted',"if(ancestors.length)out.push(","if(false)out.push("],
 ['conflicting owner values choose one',"if(owners.length>1)return {kind:'held'","if(false)return {kind:'held'"],
 ['an owner value is not materialized',"return wanted({dimension:'localization',status:'reviewed',source:'owner'","return {kind:'match',effective};wanted({dimension:'localization',status:'reviewed',source:'owner'"],
 ['a protected row of another owner value is overwritten',"if(ROW.strong(row))return row.value===value?{kind:'match',effective}:{kind:'held',reason:'protected_row_differs',effective};","if(false)return {kind:'match',effective};"],
 ['a protected row is overwritten by the automatic winner',"if(ROW.strong(row))return {kind:'held',reason:'protected_row_differs',effective};","if(false)return {kind:'held',reason:'protected_row_differs',effective};"],
 ['a moved resolver input is not detected',"if(canonicalJson(projectionInputs(snapshot,token,input.sources))!==canonicalJson(input.inputs))return {...base,state:'moved'};",''],
 ['a stale source is an exact proof',"const exact=replays.length===input.sources.length&&projection.kind==='match';","const exact=projection.kind==='match';"],
 ['the proof omits the owner token',"owner:token.digest,","owner:null,"],
 ['the proof omits the other sources',"stored,others,legacy};","stored,others:[],legacy};"],
 ['the proof omits the stored reviewed row',"owner:token.digest,stored,","owner:token.digest,stored:null,"],
 ['a held projection is written',"if(plan.state==='held')return {id,revision:snapshot.revision,written:false,held:true,","if(false)return {id,revision:snapshot.revision,written:false,held:true,"],
 ['a replay with other content is accepted',"throw failed('localization_replay_mismatch');","skipped.push({field:'source:'+item.source,reason:'replay'});replays.push(item.source);continue;"],
 ['an older observation is written','if(row&&!(observedAt>row.observed_at)){skipped.push','if(false){skipped.push'],
 ['a nothing-to-write call opens a batch',"if(plan.state!=='write')return {id,revision:snapshot.revision,written:false,reason:plan.state==='exact'","if(false)return {id,revision:snapshot.revision,written:false,reason:plan.state==='exact'"],
 ['an absent Film reaches the batch',"if(!snapshot.film)throw failed('film_person_precondition');\n const token","const token"],
 ['a non-authoritative owner domain is trusted',"if(!marker||marker.mode!=='d1'||(marker.writes!=='open'&&marker.writes!=='held'))","if(!marker)"],
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
