// AIR-374 P3-0a: mutation check of the receipt mark of the fenced canonical writers, in the pattern of tests/canonical-film-writers-mutation.mjs. Each mutant is a copy of the whole src/ directory with ONE
// rule removed or inverted in ONE file; tests/canonical-receipted-writers.mjs, pointed at the copy through RECEIPTED_SRC, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant
// that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards), so one can never be committed. Four at a time, one shared template database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const MUT='canonical-mutations.js';
const COMMIT="await fenced.commit(env,gate,statements,entities,tail);";
const PLAIN="await fenced.commit(env,gate,statements,entities);";
const writerCommit=(file,name,hint,from=COMMIT,to=PLAIN)=>['the receipt tail of '+name+' is not appended',file,from,to,hint];
// [name, file, text, replacement, whether it must occur once]
const MUTANTS=[
 ['commit ignores the receipt tail',MUT,"db.batch([...statements,...tail].map(","db.batch([...statements].map("],
 ['the tail comes before the writer statements',MUT,"db.batch([...statements,...tail].map(","db.batch([...tail,...statements].map("],
 ['the tail counts against the writer cap',MUT,"if(statements.length>MUTATION_STATEMENT_CAP||tail.length>2)","if(statements.length+tail.length>MUTATION_STATEMENT_CAP||tail.length>2)"],
 ['the tail length is not bounded',MUT,"||tail.length>2)throw failed('film_person_bounded');","||false)throw failed('film_person_bounded');"],
 ['the writer cap is not enforced',MUT,"if(statements.length>MUTATION_STATEMENT_CAP||tail.length>2)","if(tail.length>2)"],
 ['the applied update does not check the attempt',MUT,"AND state=? AND attempts=? AND target_kind","AND state=? AND ?>0 AND target_kind"],
 ['the applied update does not check the pending state',MUT,"WHERE request_id=? AND state=? AND attempts=? AND target_kind","WHERE request_id=? AND ?='pending' AND attempts=? AND target_kind"],
 ['the applied update does not check the request id',MUT,"WHERE request_id=? AND state=?","WHERE ?<>'' AND state=?"],
 // The stored receipt row is verified against the entity the writer bumps (every one of the nine writers shares this tail).
 ['the applied update does not check the stored target id',MUT,"AND target_id=? AND planned_revision","AND ?<>'' AND planned_revision"],
 ['the applied update checks neither stored target column',MUT,"AND target_kind=? AND target_id=? AND planned_revision","AND ?<>'' AND ?<>'' AND planned_revision"],
 ['the applied update does not check the stored planned revision',MUT,"AND planned_revision+1=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0) AND marker_generation","AND ?<>'' AND ?<>'' AND marker_generation"],
 ['the planned revision is compared without the +1',MUT,"AND planned_revision+1=COALESCE(","AND planned_revision=COALESCE("],
 ['the planned revision may be at or below the bumped-from revision',MUT,"AND planned_revision+1=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)","AND planned_revision+1<=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)"],
 ['the planned revision may be above the bumped-from revision',MUT,"AND planned_revision+1=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)","AND planned_revision+1>=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)"],
 ['the applied update does not check the stored marker generation',MUT,"AND marker_generation=COALESCE((SELECT generation FROM film_person_authority WHERE id=1),-1)\";","\";"],
 ['the applied update compares the marker generation with a constant',MUT,"AND marker_generation=COALESCE((SELECT generation FROM film_person_authority WHERE id=1),-1)\";","AND marker_generation>=0\";"],
 ['the applied update has no assertion',MUT,"[assertSql('changes()>=1'),[]]];\n// What a writer","[assertSql('1'),[]]];\n// What a writer"],
 ['the applied revision is not read after the bump',MUT,"applied_revision=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)","applied_revision=COALESCE((SELECT revision FROM canonical_revision WHERE kind=? AND id=?),0)-1"],
 ['a mark for another entity is accepted',MUT,"&&mark.target&&mark.target.kind===entity.kind&&mark.target.id===entity.id;","&&true;"],
 ['a mark for another kind is accepted',MUT,"mark.target.kind===entity.kind&&","true&&"],
 ['attempt zero is accepted',MUT,"Number.isInteger(mark.attempt)&&mark.attempt>=1","Number.isInteger(mark.attempt)"],
 ['a text attempt is accepted',MUT,"Number.isInteger(mark.attempt)&&","mark.attempt>=1&&"],
 ['an empty request id is accepted',MUT,"typeof mark.requestId==='string'&&mark.requestId&&","true&&"],
 ['a missing clock is accepted',MUT,"&&typeof mark.now==='string'&&mark.now\n","\n"],
 ['an invalid mark is ignored',MUT,"if(!ok)throw failed('film_person_invalid');\n return appliedTail","if(!ok)return [];\n return appliedTail"],
 ['an absent mark yields a tail',MUT,"if(mark===undefined||mark===null)return [];","if(false)return [];"],
 ['the receipt module builds its own tail',"canonical-receipts.js","return fenced.appliedTail({requestId,attempt,target,now});","return [];"],
 ['mutateFilm drops the tail',MUT,"await commit(env,gate,statements,entities,tail);\n return {id,revision:expected+1};\n}\n\n// One Person","await commit(env,gate,statements,entities);\n return {id,revision:expected+1};\n}\n\n// One Person"],
 ['mutatePerson drops the tail',MUT,"statements.push([BUMP,['person',id,at]]);\n await commit(env,gate,statements,entities,tail);","statements.push([BUMP,['person',id,at]]);\n await commit(env,gate,statements,entities);"],
 ['mutateFilm validates no mark',MUT,"const tail=receiptTail(input.receiptMark,{kind:'film',id});","const tail=[];"],
 ['mutatePerson validates no mark',MUT,"const tail=receiptTail(input.receiptMark,{kind:'person',id});","const tail=[];"],
 writerCommit('canonical-film-writers.js','writeFilmFacts','x',"await fenced.commit(env,gate,statements,entities,tail);\n return {id,revision:expected+1,written:true","await fenced.commit(env,gate,statements,entities);\n return {id,revision:expected+1,written:true"),
 ['writeFilmFacts checks the mark against another entity','canonical-film-writers.js',"fenced.receiptTail(input.receiptMark,{kind:'film',id})","fenced.receiptTail(input.receiptMark,{kind:'film',id:input.receiptMark?.target?.id})"],
 ['recordPersonState drops the tail','canonical-person-state.js',"statements.push([fenced.BUMP,['person',id,at]]);\n await fenced.commit(env,gate,statements,entities,tail);","statements.push([fenced.BUMP,['person',id,at]]);\n await fenced.commit(env,gate,statements,entities);"],
 ['recordLocalizationConflicts drops the tail','canonical-person-state.js',"statements.push([fenced.BUMP,[kind,id,at]]);\n await fenced.commit(env,gate,statements,entities,tail);","statements.push([fenced.BUMP,[kind,id,at]]);\n await fenced.commit(env,gate,statements,entities);"],
 ['recordLocalizationSources drops the tail','localization-sources.js',COMMIT,PLAIN],
 ['recordLocalizationSources checks the wrong kind','localization-sources.js',"fenced.receiptTail(input.receiptMark,{kind:spec.entity,id})","fenced.receiptTail(input.receiptMark,{kind:input.receiptMark?.target?.kind,id})"],
 ['admitRatedFilm drops the tail','film-admission.js',"try{await fenced.commit(env,gate,statements,entities,tail);}","try{await fenced.commit(env,gate,statements,entities);}"],
 ['retainFilm drops the tail','film-admission.js',"await fenced.commit(env,gate,statements,entities,tail);\n return {id,revision:expected+1,retained:true,written:true};","await fenced.commit(env,gate,statements,entities);\n return {id,revision:expected+1,retained:true,written:true};"],
 ['recordRetirementDecision drops the tail','tmdb-retirement-decisions.js',"try{await fenced.commit(env,gate,statements,entities,tail);}","try{await fenced.commit(env,gate,statements,entities);}"],
 ['recordRetirementDecision checks no entity','tmdb-retirement-decisions.js',"fenced.receiptTail(input.receiptMark,{kind:'film',id:decision.filmId})","fenced.receiptTail(input.receiptMark,{kind:'film',id:input.receiptMark?.target?.id})"],
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipted-writers-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-receipted-writers.mjs'],{env:{...process.env,RECEIPTED_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{RECEIPTED_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.RECEIPTED_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-receipted-writers-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
