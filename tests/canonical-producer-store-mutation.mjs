// AIR-374 S4-3: mutation check of the dormant producer store (src/canonical-producer-store.js), in the pattern of
// tests/canonical-film-external-ids-producer-mutation.mjs. Each mutant is a copy of the whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/canonical-producer-store.mjs, pointed at the copy through PRODUCER_STORE_SRC, must FAIL on it.
// A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const MUTANTS=[
 ["the route gate is ignored", "canonical-producer-store.js", "return route.writer==='canonical'?{open:true,generation:route.generation}:{open:false};", "return {open:true,generation:route.generation};"],
 ["the create is not insert-or-ignore", "canonical-producer-store.js", "ON CONFLICT(origin,run_key) DO NOTHING", ""],
 ["an existing run of another source generation is resumed or replayed", "canonical-producer-store.js", "if(stored.source_generation!==sourceGeneration)throw failed('producer_source_generation_mismatch');", ""],
 ["an equal fingerprint is not resumed", "canonical-producer-store.js", "if(decision.action==='resume')return", "if(false)return"],
 ["the replay keeps the strike count", "canonical-producer-store.js", "strike_count=0,pass_state='passing',stopped_by=NULL,revision=revision+1,updated_at=? WHERE origin='epg'", "pass_state='passing',stopped_by=NULL,revision=revision+1,updated_at=? WHERE origin='epg'"],
 ["a lost compare-and-set is not named", "canonical-producer-store.js", "if(!stored||stored.revision!==run.revision)return failed('producer_cas_lost',error);", ""],
 ["a moved marker is not named", "canonical-producer-store.js", "if(again.state!=='open'||again.generation!==gate.generation)return failed('film_person_fence',error);", ""],
 ["a missing table is not named", "canonical-producer-store.js", "if(/no such table: canonical_producer/i.test(message))return failed('producer_store_missing',error);", ""],
 ["the slice counts are set, not added", "canonical-producer-store.js", "n_applied=n_applied+?,", "n_applied=?,"],
 ["the slice counts of failures are set", "canonical-producer-store.js", "n_failed=n_failed+?,", "n_failed=?,"],
 ["a strike count of three is passed to SQL", "canonical-producer-store.js", "next.strike_count>2", "next.strike_count>3"],
 ["the pass-complete accepts a dictionary run", "canonical-producer-store.js", "run.origin!=='epg'||typeof run.source_generation", "typeof run.source_generation"],
 ["a stop code is not validated", "canonical-producer-store.js", "||!/^[a-z][a-z_0-9]{0,79}$/.test(stoppedBy)", ""],
 ["an equal dictionary digest mints", "canonical-producer-store.js", "if(verdict.action==='reuse')return", "if(false)return"],
 ["the previous dictionary version is not superseded", "canonical-producer-store.js", "if(verdict.supersedes)statements.push", "if(false)statements.push"],
 ["a lost dictionary race is not retried", "canonical-producer-store.js", "if(error?.code==='producer_cas_lost'&&attempt<2)continue;", ""],
 ["a permanent refusal is due", "canonical-producer-store.js", "state IN ('open','refused_recoverable') AND next_attempt_at<=?", "state IN ('open','refused_recoverable','refused_permanent') AND (next_attempt_at<=? OR next_attempt_at IS NULL)"],
 ["the settle ignores the attempts", "canonical-producer-store.js", "AND state=? AND attempts=?", "AND state=? AND attempts<=?"],
 ["a terminal row is settled again", "canonical-producer-store.js", "!canTransition(row.state,state)||", ""],
 ["a non-terminal settle state is accepted", "canonical-producer-store.js", "!TERMINAL_STATES.includes(state)||", ""],
 ["the slice cap is ignored", "canonical-producer-store.js", "if(statements.length>SLICE_STATEMENT_CAP)throw failed('film_person_bounded');", ""],
 ["a superseded result is not closed", "canonical-producer-store.js", "if(write.supersede){", "if(false){"],
 ["the superseded row keeps its schedule", "canonical-producer-store.js", "settled_by=?,settled_at=?,updated_at=?,next_attempt_at=NULL WHERE origin=? AND run_key=? AND pass_no=? AND kind=? AND unit_id=? AND state IN (\"+LIVE_STATES", "settled_by=?,settled_at=?,updated_at=? WHERE origin=? AND run_key=? AND pass_no=? AND kind=? AND unit_id=? AND state IN (\"+LIVE_STATES"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'producer-store-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-producer-store.mjs'],{env:{...process.env,PRODUCER_STORE_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{PRODUCER_STORE_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.PRODUCER_STORE_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-producer-store-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
