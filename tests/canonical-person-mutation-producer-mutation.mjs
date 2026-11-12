// AIR-374 P3a `person_mutation` (ADR 0130): mutation check of the dormant Person-row unit (src/canonical-person-mutation-producer.js), the additive `presence` option of mutatePerson, its EPG Person layer integration and the operation kind, in the pattern of
// tests/canonical-epg-person-producer-mutation.mjs. Each mutant is a copy of the whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/canonical-person-mutation-producer.mjs, pointed at the copy through EPG_SRC, must FAIL on it.
// A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

// [name, file in src/, exact text that occurs once, replacement]
const MUTANTS=[
 ["the digest does not bind the target", "canonical-person-mutation-producer.js", "digestOf({operation:PERSON_MUTATION_OPERATION,id:input?.id,content:", "digestOf({operation:PERSON_MUTATION_OPERATION,content:"],
 ["the mode is not content", "canonical-person-mutation-producer.js", "return {mode,roleId:person.roleId", "return {roleId:person.roleId"],
 ["external ids are digested unsorted", "canonical-person-mutation-producer.js", "externalIds.sort((a,b)=>byKey(JSON.stringify([a.scheme,a.value]),JSON.stringify([b.scheme,b.value])));", ""],
 ["a blank role id is accepted", "canonical-person-mutation-producer.js", "!filled(person.roleId)||", ""],
 ["a duplicate external id is accepted", "canonical-person-mutation-producer.js", "if(seenIds.has(key))throw failed('film_person_invalid');", ""],
 ["the unit size is unbounded", "canonical-person-mutation-producer.js", "if(externalIds.length+aliases.length>PERSON_ITEMS_PER_UNIT_MAX)throw failed('film_person_bounded');", ""],
 ["mode existing creates", "canonical-person-mutation-producer.js", "if(content.mode==='existing')return {absent:true", "if(false)return {absent:true"],
 ["a role held by another Person is not refused", "canonical-person-mutation-producer.js", "if(await one(db,'SELECT 1 AS x FROM person WHERE role_id=?',[content.roleId]))throw failed('person_role_collision');", ""],
 ["a stored role id mismatch is not refused", "canonical-person-mutation-producer.js", "if(row.role_id!==content.roleId)throw failed('person_role_collision');", ""],
 ["stored external ids are rewritten", "canonical-person-mutation-producer.js", "content.externalIds.filter(item=>!haveIds.has(", "content.externalIds.filter(item=>true||!haveIds.has("],
 ["a trusted clash is not refused", "canonical-person-mutation-producer.js", "if(item.trusted&&stored.some(", "if(false&&stored.some("],
 ["every alias is missing", "canonical-person-mutation-producer.js", "content.aliases.filter(item=>!haveAliases.has(", "content.aliases.filter(item=>true||!haveAliases.has("],
 ["nothing is ever a no-op", "canonical-person-mutation-producer.js", "const noop=externalIds.length===0&&aliases.length===0;", "const noop=false;"],
 ["the stored contract version is overwritten", "canonical-person-mutation-producer.js", "contractVersion:row.contract_version,externalIds,aliases}", "contractVersion:content.contractVersion,externalIds,aliases}"],
 ["the pre-plan revision is zero", "canonical-person-mutation-producer.js", "const revision=await revisionOf(db,input.id);", "const revision=0;"],
 ["the batch does not prove presence", "canonical-person-mutation-producer.js", "presence:plan.action==='create'?'absent':'existing'", "presence:undefined"],
 ["a vanished Person of mode existing is written", "canonical-person-mutation-producer.js", "if(plan.absent)throw failed('film_person_reference');", ""],
 ["a credit-free no-op still writes", "canonical-person-mutation-producer.js", "if(plan.noop)return {id:input.id,revision:plan.revision,already:true};", ""],
 ["the write has no receipt mark", "canonical-person-mutation-producer.js", "receiptMark:mark(ctx,clock)});", "});"],
 ["a moved source is replayed", "canonical-person-mutation-producer.js", "if(!found.ok)throw failed('film_person_invalid');", ""],
 ["a moved source is not abandoned by readback", "canonical-person-mutation-producer.js", "if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};", ""],
 ["readback never finds the facts", "canonical-person-mutation-producer.js", "digest:plan?.noop?receipt.contentDigest:null", "digest:null"],
 ["revalidate never supersedes an absent Person", "canonical-person-mutation-producer.js", "return plan.absent||plan.noop?'superseded':'proceed';", "return plan.noop?'superseded':'proceed';"],
 ["revalidate always proceeds", "canonical-person-mutation-producer.js", "return plan.absent||plan.noop?'superseded':'proceed';", "return 'proceed';"],
 ["every planner error is a missing plan", "canonical-person-mutation-producer.js", "if(PERSON_MUTATION_REFUSALS.has(error?.code))return null;throw error;", "return null;"],
 ["a role collision is not a content refusal", "canonical-person-mutation-producer.js", "[...CONTENT_REFUSALS,'person_role_collision','identity_collision']", "[...CONTENT_REFUSALS,'identity_collision']"],
 ["the pass gate ignores the route", "canonical-person-mutation-producer.js", "if(route.writer!=='canonical')return {state:'skipped'", "if(false)return {state:'skipped'"],
 ["the receipt plans revision zero", "canonical-person-mutation-producer.js", "expectedRevision:plan.revision,digest", "expectedRevision:0,digest"],
 ["the writer does not prove an existing Person", "canonical-mutations.js", "if(input.presence==='existing')statements.push(", "if(false)statements.push("],
 ["the writer does not prove an absent Person", "canonical-mutations.js", "if(input.presence==='absent')statements.push(", "if(false)statements.push("],
 ["Person rows are planned last", "canonical-epg-person-producer.js", "const units=[...[...rows.values()].sort(byId),...[...people.values()].sort(byId),...[...films.values()].sort(byId)];", "const units=[...[...people.values()].sort(byId),...[...films.values()].sort(byId),...[...rows.values()].sort(byId)];"],
 ["the apply map has no person_mutation", "canonical-epg-person-producer.js", "[PERSON_MUTATION_OPERATION]:applyPersonMutation}", "}"],
 ["the reconcile has no person_mutation", "canonical-epg-person-producer.js", "  [PERSON_MUTATION_OPERATION,personMutationOperation({replan:personReplan,...clock})],\n", ""],
 ["a Person row mode is dropped", "canonical-epg-person-producer.js", "...(item.mode!==undefined?{mode:item.mode}:{}),", ""],
 ["another Person's trusted id is not refused (update)", "canonical-person-mutation-producer.js", "for(const item of externalIds)if(item.trusted&&stored.some(have=>have.scheme===item.scheme&&have.trusted===1&&have.conflicting===0&&have.value!==item.value))throw failed('identity_collision');\n await assertNoOtherOwner(db,input.id,externalIds);", "for(const item of externalIds)if(item.trusted&&stored.some(have=>have.scheme===item.scheme&&have.trusted===1&&have.conflicting===0&&have.value!==item.value))throw failed('identity_collision');"],
 ["another Person's trusted id is not refused (create)", "canonical-person-mutation-producer.js", "await assertNoOtherOwner(db,input.id,content.externalIds);\n  return", "return"],
 ["a conflicting or untrusted copy counts as an owner", "canonical-person-mutation-producer.js", "if(item.trusted&&await one(db,'SELECT 1 AS x FROM person_external_id WHERE scheme=? AND value=? AND trusted=1 AND conflicting=0 AND person_id<>?'", "if(await one(db,'SELECT 1 AS x FROM person_external_id WHERE scheme=? AND value=? AND person_id<>?'"],
 ["the write does not ask for the trusted-owner proof", "canonical-person-mutation-producer.js", "uniqueTrusted:true,", ""],
 ["the writer does not prove the trusted owner", "canonical-mutations.js", "if(input.uniqueTrusted===true){", "if(false){"],
 ["the writer accepts any uniqueTrusted", "canonical-mutations.js", "if(input.uniqueTrusted!==undefined&&input.uniqueTrusted!==true)throw failed('film_person_invalid');", ""],
 ["a duplicate Person row is accepted by the wrapper", "canonical-epg-person-producer.js", "if(seenRows.has(item.id))throw failed('film_person_invalid');", ""],
 ["a Person row shares the Person id set", "canonical-epg-person-producer.js", "if(seenRows.has(item.id))throw failed('film_person_invalid');\n   seenRows.add(item.id);", "if(seen.has(item.id))throw failed('film_person_invalid');\n   seen.add(item.id);"],
 ["a bounded Person row is not a per-unit refusal", "canonical-epg-person-producer.js", "if(error?.code!=='film_person_invalid'&&error?.code!=='film_person_bounded')throw error;code=error.code;", "if(error?.code!=='film_person_invalid')throw error;code=error.code;"],
 ["the wrapper drops the Person rows", "canonical-epg-person-producer.js", "personRows:keepRows});", "});"],
 ["a refused Person row is kept in the plan", "canonical-epg-person-producer.js", "if(code){refused.push({kind:PERSON_MUTATION_OPERATION,id:item.id,code,source:source(item)});continue;}", "if(code){refused.push({kind:PERSON_MUTATION_OPERATION,id:item.id,code,source:source(item)});}"],
 ["person_mutation is not a cursor kind", "canonical-producer-run.js", "person_mutation:2,person_state:3,film_credits:4}", "person_state:3,film_credits:4}"],
 ["person_mutation ranks after person_state", "canonical-producer-run.js", "person_mutation:2,person_state:3,film_credits:4}", "person_mutation:3.5,person_state:3,film_credits:4}"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'person-mutation-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-person-mutation-producer.mjs'],{env:{...process.env,EPG_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{EPG_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.EPG_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-person-mutation-producer-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
