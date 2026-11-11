// AIR-374 P2b: mutation check of the safety-critical rules of src/canonical-person-state.js, in the pattern of tests/projector-marker-fence-mutation.mjs. Each mutant is a copy of
// the module with ONE rule removed or inverted; tests/canonical-person-state.mjs, pointed at the mutant through CANON_PERSON_STATE_SOURCE, must FAIL on it. A surviving mutant is a rule
// no test depends on; a mutant that does not parse or load is BROKEN and fails this check. The mutants are written OUTSIDE the repository tree (a temporary directory, removed afterwards),
// their relative imports rewritten to the repository sources, so a mutant copy can never be committed. Each mutant runs only its own targeted test file, at most four at a time.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const FILE='src/canonical-person-state.js';
const source=fs.readFileSync(FILE,'utf8');
const MUTANTS=[
 // the fence and the gate
 ['the marker gate is skipped (person state)',"const gate=assertWritable(await readAuthority(env));\n const db=database(env);\n if(!(await one(db,'SELECT 1 AS x FROM person WHERE id=?',[id])))","const gate=await readAuthority(env);\n const db=database(env);\n if(!(await one(db,'SELECT 1 AS x FROM person WHERE id=?',[id])))"],
 ['the marker gate is skipped (conflicts)',"const gate=assertWritable(await readAuthority(env));\n const db=database(env);\n if(kind==='film'","const gate=await readAuthority(env);\n const db=database(env);\n if(kind==='film'"],
 ['the person-state batch carries no fence head',"const statements=fenced.head(gate,entities);\n for(const item of plan.statements)","const statements=[];\n for(const item of plan.statements)"],
 ['the conflict batch carries no fence head',"const statements=fenced.head(gate,entities);\n statements.push(kind==='film'","const statements=[];\n statements.push(kind==='film'"],
 ['the person-state write bumps no revision',"statements.push([fenced.BUMP,['person',id,at]]);","void 0;"],
 ['the conflict write bumps no revision',"statements.push([fenced.BUMP,[kind,id,at]]);","void 0;"],
 ['the person-state write proves no revision',"const entities=[{kind:'person',id,expected}];\n const statements=fenced.head(gate,entities);\n for(","const entities=[];\n const statements=fenced.head(gate,entities);\n for("],
 ['the person row is not required in the batch',"const statements=[[fenced.assertSql('EXISTS (SELECT 1 FROM person WHERE id=?)'),[id]]];","const statements=[];"],
 ['a redirected Film takes a conflict',"if(kind==='film'&&await one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[id]))throw failed('film_person_redirect');",""],
 // never downgrade an owner or reviewed value
 ['the guard never keeps a reviewed value',"if(!stored||stored.status!=='reviewed'||replacesStored(stored,entity.localization))return entity;","return entity;"],
 ['the guard keeps nothing for an owner value',"const reason=stored.authority==='owner'?'owner_kept':'reviewed_kept';","const reason='reviewed_kept';"],
 ['a dictionary review replaces an owner value',"if(stored?.authority==='owner')return incoming?.status==='reviewed'&&incoming?.provenance?.authority==='owner';","if(stored?.authority==='owner')return incoming?.status==='reviewed';"],
 ['an automatic value replaces a reviewed one',"return authority==='dictionary'||authority==='owner'||state.source==='dictionary';","return true;"],
 ['the in-batch upsert guard overwrites a reviewed value',"WHERE person_dimension.status<>'reviewed' OR (person_dimension.authority='owner' AND excluded.status='reviewed' AND excluded.authority='owner') OR (COALESCE(person_dimension.authority,'')<>'owner' AND excluded.status='reviewed' AND (excluded.authority IN ('dictionary','owner') OR excluded.source='dictionary'))`;","WHERE 1`;"],
 ['the in-batch upsert guard lets any reviewed state replace an owner',"(person_dimension.authority='owner' AND excluded.status='reviewed' AND excluded.authority='owner')","(person_dimension.authority='owner' AND excluded.status='reviewed')"],
 ['the held-value statements are not run',"for(const item of heldStatements(id,guarded.localization))statements.push(item);",""],
 ['the domain conflicts of the input are dropped',"  statements.push([CONFLICT_INSERT,row]);\n }\n return out;","  void row;\n }\n return out;"],
 // the rows equal the projector's
 ['the conflict id is not the projector\'s',"return [kind+':'+id+':'+JSON.stringify({reason:conflict.reason,","return [kind+'/'+id+':'+JSON.stringify({reason:conflict.reason,"],
 ['the identity dimension is not replaced',"statements.push([\"DELETE FROM person_dimension WHERE person_id=? AND dimension<>'localization'\",[id]]);",""],
 ['an existing conflict is overwritten',"VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING';","VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at';"],
 // replay by content
 ['a replay is never recognised (person state)',"if(await personStateSatisfied(db,id,plan,stored))return","if(false)return"],
 ['every call counts as a replay (person state)',"if(await personStateSatisfied(db,id,plan,stored))return","if(true)return"],
 ['a replay ignores the stored conflicts',"for(const key of conflicts)if(!(await exists(","for(const key of [])if(!(await exists("],
 ['a replay ignores the stored localization row',"if(upsertOverwrites(stored,plan.localization)&&!same(stored,plan.localization))return false;","void stored;"],
 ['a replay of conflicts is never recognised',"if(rows.every(row=>have.has(row[0])))return","if(false)return"],
 ['the held reason ignores the NULL logic',"return and3((stored.value??null)!==(incoming?.value??null),not3(replaced))===true?","return and3((stored.value??null)!==(incoming?.value??null),not3(replaced))!==false?"],
];
// The numbered sections of tests/canonical-person-state.mjs that must kill each mutant (CANON_PERSON_STATE_ONLY), so a mutant does not pay for the whole file.
const SECTIONS={
 "the marker gate is skipped (person state)": "2",
 "the marker gate is skipped (conflicts)": "2",
 "the person-state batch carries no fence head": "5",
 "the conflict batch carries no fence head": "6",
 "the person-state write bumps no revision": "5",
 "the conflict write bumps no revision": "6",
 "the person-state write proves no revision": "5",
 "the person row is not required in the batch": "5",
 "a redirected Film takes a conflict": "6",
 "the guard never keeps a reviewed value": "1,4",
 "the guard keeps nothing for an owner value": "1,4",
 "a dictionary review replaces an owner value": "1,4",
 "an automatic value replaces a reviewed one": "1,4",
 "the in-batch upsert guard overwrites a reviewed value": "5",
 "the in-batch upsert guard lets any reviewed state replace an owner": "5",
 "the held-value statements are not run": "5",
 "the domain conflicts of the input are dropped": "3",
 "the conflict id is not the projector's": "6",
 "the identity dimension is not replaced": "3",
 "an existing conflict is overwritten": "6",
 "a replay is never recognised (person state)": "5",
 "every call counts as a replay (person state)": "4",
 "a replay ignores the stored conflicts": "5",
 "a replay ignores the stored localization row": "4",
 "a replay of conflicts is never recognised": "6",
 "the held reason ignores the NULL logic": "3"
};
for(const [name] of MUTANTS)assert.equal(typeof SECTIONS[name],'string','every mutant names the sections that must kill it: '+name);
for(const [name,from] of MUTANTS)assert.equal(source.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+FILE);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canonical-person-state-mutants-'));
const absolute=text=>text.replace(/from '\.\/([^']+)'/g,(_,name)=>"from '"+pathToFileURL(path.resolve('src',name)).href+"'");
const run=env=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/canonical-person-state.mjs'],{env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
});
try{
 const queue=MUTANTS.map(([name,from,to],index)=>{
  const mutant=path.join(dir,'mutant'+index+'.mjs');
  fs.writeFileSync(mutant,absolute(source.replace(from,()=>to)));
  return {name,env:{CANON_PERSON_STATE_SOURCE:mutant,CANON_PERSON_STATE_ONLY:SECTIONS[name]}};
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.env)===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-person-state-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
