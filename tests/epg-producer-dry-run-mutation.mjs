// AIR-374 M2: mutation check of the offline dry-run harness (scripts/epg-producer-dry-run.mjs), in the pattern of
// tests/canonical-film-external-ids-producer-mutation.mjs. Each mutant is a copy of the whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/epg-producer-dry-run.mjs, pointed at the copy through DRYRUN_SCRIPT, must FAIL on it.
// A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const MUTANTS=[
 ["the guard allows a batch", "batch(){throw new DryRunWriteRefused('batch');},", "batch(statements){return binding.batch(statements);},"],
 ["the guard does not check statements", "try{assertReadOnly(sql);}catch", "try{}catch"],
 ["the guard allows exec", "exec(){throw new DryRunWriteRefused('exec');},", "exec(sql){return binding.exec(sql);},"],
 ["the read counter is not incremented", "counter.queries++;\n   return binding.prepare(sql);", "return binding.prepare(sql);"],
 ["no write clock is required", "if(typeof at!=='string'||!at)throw new DryRunWriteRefused('a write clock is required');", ""],
 ["a no-op counts as changed", "if(plan.absent)row.absent++;else if(plan.noop)row.noop++;else row.changed++;", "if(plan.absent)row.absent++;else row.changed++;"],
 ["an absent unit counts as a no-op", "if(plan.absent)row.absent++;else if(plan.noop)row.noop++;else row.changed++;", "if(plan.absent||plan.noop)row.noop++;else row.changed++;"],
 ["a release is not resolved against the store", "digestInput=await resolveReleaseInput(guarded,unit.input);", "digestInput=unit.input;"],
 ["the planner refusals are not counted", "for(const item of refusedPlanner){bucket(item.kind).refused++;", "for(const item of []){bucket(item.kind).refused++;"],
 ["the changed share has a wrong denominator", "Number((changed/total).toFixed(4))", "Number((changed/(total+1)).toFixed(4))"],
 ["the report claims writes", "writes:0,", "writes:units.length,"],
 ["the report names the units", "writes:0,", "writes:0,ids:units.map(unit=>unit.id),"],
 ["a thrown write refusal is swallowed", "if(code==='dry_run_write_refused')throw error;", ""]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dry-run-mutants-'));
try{
 const original=fs.readFileSync('scripts/epg-producer-dry-run.mjs','utf8');
 for(const [name,from] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once');
 const run=file=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/epg-producer-dry-run.mjs'],{env:{...process.env,DRYRUN_SCRIPT:file},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+file+': '+err.slice(0,300));resolve(code);});
 });
 // each copy sits in its own directory with its own scripts/ and a src/ copy, so its relative imports resolve
 const place=(index,text)=>{
  const base=path.join(dir,'m'+index);
  fs.mkdirSync(path.join(base,'scripts'),{recursive:true});
  fs.cpSync('src',path.join(base,'src'),{recursive:true});
  fs.copyFileSync('scripts/schema-preflight.mjs',path.join(base,'scripts','schema-preflight.mjs'));
  const file=path.join(base,'scripts','epg-producer-dry-run.mjs');
  fs.writeFileSync(file,text);
  return file;
 };
 assert.equal(await run(place('base',original)),0,'the unmutated copy passes the whole test');
 const queue=MUTANTS.map(([name,from,to],index)=>({name,file:place(index,original.replace(from,()=>to))}));
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.file);if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('epg-producer-dry-run-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
