// AIR-374 P2a / ADR 0120: mutation check of the canonical Film writers. Each mutant is a copy of src/canonical-film-writers.js with ONE safety rule removed or
// inverted; tests/canonical-film-writers.mjs, pointed at the mutant through FILM_WRITERS_SOURCE, must FAIL on it. A surviving mutant is a rule no test depends on.
// Mutants are written OUTSIDE the repository tree (a temporary directory, removed afterwards), with the relative imports turned into absolute file URLs.
// Fast by construction: the target test builds one template database per stage and copies it, and the mutants run four at a time.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const SOURCE='src/canonical-film-writers.js';
const source=fs.readFileSync(SOURCE,'utf8');
const MUTANTS=[
 ['the marker gate is skipped',"const gate=assertWritable(await readAuthority(env));","const gate={generation:2};",'1'],
 ['the caller revision is ignored',"const entities=[{kind:'film',id,expected}];\n const statements=fenced.head(gate,entities);","const entities=[{kind:'film',id,expected:snapshot.revision}];\n const statements=fenced.head(gate,entities);",'2'],
 ['a replay opens a batch',"if(plan.noop)return {id,revision:snapshot.revision,written:false","if(false)return {id,revision:snapshot.revision,written:false",'2'],
 ['a blank title overwrites',"if(!blank(filmIn.originalTitle)){","if(filmIn.originalTitle!==undefined&&filmIn.originalTitle!==null){",'6'],
 ['a reviewed or owner identity row does not hold the title',"else if(strong(identityDim)&&!incomingOwner)skipped.push({field:'originalTitle'","else if(false)skipped.push({field:'originalTitle'",'6'],
 ['an untrusted source overwrites the title',"else if(rank(source)<0)skipped.push({field:'originalTitle'","else if(false)skipped.push({field:'originalTitle'",'7'],
 ['a lower source overwrites the title',"else if(rank(source)<rank(titleSourceOf(identityDim)))skipped.push","else if(false)skipped.push",'7'],
 ['an equal source cannot overwrite',"else if(rank(source)<rank(titleSourceOf(identityDim)))skipped.push","else if(rank(source)<=rank(titleSourceOf(identityDim)))skipped.push",'7b'],
 ['the title rank is read from identity.source',"else if(rank(source)<rank(titleSourceOf(identityDim)))skipped.push","else if(rank(source)<rank(identityDim?.source))skipped.push",'7'],
 ['a bare owner name ranks as the owner',"(filmIn.source!=='owner'||filmIn.authority==='owner')","true",'7b'],
 ['the title provenance replaces the other keys',"provenance_json=json_set(COALESCE(provenance_json,'{}'),'$.titleSource',json(?))","provenance_json=json_object('titleSource',json(?))",'2'],
 ['a dimension write drops the stored provenance keys',"provenance:{...kept,...rest}","provenance:{...rest}",'2'],
 ['a named clock clear is ignored',"for(const name of clear)final[NAMES[name]]=null;","",'9'],
 ['canonical_identity needs no trusted tmdb id',"||!snapshot.trustedTmdb.includes(wanted.slice(5)))",")",'7'],
 ['a canonical_identity change needs no evidence',"else if(input.evidence?.verified!==true)throw failed('film_person_identity_conflict');","else if(false)throw failed('film_person_identity_conflict');",'7'],
 ['a reviewed identity row is replaced by an automatic one',"if(strong(row)&&!(row.authority==='owner'?(params[2]==='reviewed'&&params[7]==='owner'):(params[2]==='reviewed'&&(params[7]==='dictionary'||params[7]==='owner'||params[3]==='dictionary')))){skipped.push({field:'dimension:'+name","if(false){skipped.push({field:'dimension:'+name",'6'],
 ['a blank metadata field overwrites',"out[name]=blank(incoming[name])?(base[name]??null):incoming[name];","out[name]=incoming[name]??null;",'6'],
 ['empty genres overwrite',"out.genres=blank(incoming.genres)?(base.genres||[]):incoming.genres;","out.genres=incoming.genres||[];",'6'],
 ['a null clock overwrites',"const pick=(next,old)=>blank(next)?(old??null):next;","const pick=(next,old)=>next??null;",'6'],
 ['a blank localization overwrites',"if(blank(state.value)&&state.status!=='reviewed'&&row&&!blank(row.value))","if(false)",'6'],
 ['a reviewed localization is replaced by an automatic state',"else if(strong(row)&&!(row.authority==='owner'?(params[2]==='reviewed'&&params[7]==='owner'):(params[2]==='reviewed'&&(params[7]==='dictionary'||params[7]==='owner'||params[3]==='dictionary'))))skipped.push({field:'localization'","else if(false)skipped.push({field:'localization'",'6'],
 ['an older observation is written',"if(row&&!(observedAt>row.observed_at)){","if(false){",'8'],
 ['a reserved source is accepted',"||RESERVED.has(item.source)||seen.has(item.source)","||seen.has(item.source)",'8'],
 ['the effective localization is not materialised',"if(effective.tier==='automatic'){","if(false){",'8'],
];
for(const [name,from] of MUTANTS)assert.equal(source.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+SOURCE);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'film-writers-mutants-'));
const absolute=text=>text.replace(/from '\.\/([^']+)'/g,(_,file)=>"from '"+pathToFileURL(path.resolve('src',file)).href+"'");
const run=(env,only)=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/canonical-film-writers.mjs'],{env:{...process.env,...env,...(only?{FILM_WRITERS_SECTIONS:only}:{})},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=MUTANTS.map(([name,from,to,hint],index)=>{
  const file=path.join(dir,'mutant'+index+'.mjs');
  fs.writeFileSync(file,absolute(source).replace(from,()=>to));
  return {name,hint,env:{FILM_WRITERS_SOURCE:file}};
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 // AIR-374: the last element of a mutant is the section of tests/canonical-film-writers.mjs that kills it, run first; a mutant that passes its section is run against the WHOLE file before it is called a survivor,
 // so a stale number costs time and never hides a survivor. The unmutated control runs the whole file.
 let fullRuns=0;
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();let code=await run(item.env,item.hint);if(code===0){fullRuns++;code=await run(item.env);}if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-film-writers-mutation: ok ('+MUTANTS.length+' mutants killed'+(fullRuns?', '+fullRuns+' needed the whole file: update their section':'')+')');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
