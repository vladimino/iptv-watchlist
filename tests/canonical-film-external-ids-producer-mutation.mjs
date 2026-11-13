// AIR-374 P3a `film_external_ids` (ADR 0133): mutation check of the dormant Film external-id unit (src/canonical-film-external-ids-producer.js), its operation kind and the two `mutateFilm` options it relies on, in the pattern of
// tests/canonical-person-mutation-producer-mutation.mjs. Each mutant is a copy of the whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/canonical-film-external-ids-producer.mjs, pointed at the copy through FILM_EXT_SRC, must FAIL on it.
// A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

// [name, file in src/, exact text that occurs once, replacement]
const MUTANTS=[
 ["the digest does not bind the target", "canonical-film-external-ids-producer.js", "digestOf({operation:FILM_EXTERNAL_IDS_OPERATION,id:input?.id,content:", "digestOf({operation:FILM_EXTERNAL_IDS_OPERATION,content:"],
 ["the owned schemes are not content", "canonical-film-external-ids-producer.js", "return {schemes,externalIds};", "return {externalIds};"],
 ["external ids are digested unsorted", "canonical-film-external-ids-producer.js", "externalIds.sort((a,b)=>byKey(keyOf(a.scheme,a.value),keyOf(b.scheme,b.value)));", ""],
 ["schemes are digested unsorted", "canonical-film-external-ids-producer.js", "schemes.sort();", ""],
 ["an empty scheme list is accepted", "canonical-film-external-ids-producer.js", "!Array.isArray(input.schemes)||!input.schemes.length||", "!Array.isArray(input.schemes)||"],
 ["a duplicate scheme is accepted", "canonical-film-external-ids-producer.js", "!SCHEME.test(scheme)||schemes.includes(scheme)", "!SCHEME.test(scheme)"],
 ["a source id outside the owned schemes is accepted", "canonical-film-external-ids-producer.js", "||!schemes.includes(item.scheme)||", "||"],
 ["a duplicate source id is accepted", "canonical-film-external-ids-producer.js", "if(seen.has(key))throw failed('film_person_invalid');", ""],
 ["the content size is unbounded", "canonical-film-external-ids-producer.js", "if(externalIds.length>FILM_EXTERNAL_IDS_PER_UNIT_MAX)throw failed('film_person_bounded');", ""],
 ["the plan size is unbounded", "canonical-film-external-ids-producer.js", "if(add.length+remove.length>FILM_EXTERNAL_IDS_PER_UNIT_MAX)throw failed('film_person_bounded');", ""],
 ["a redirected Film is not refused", "canonical-film-external-ids-producer.js", "if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[input.id]))throw failed('film_person_redirect');", ""],
 ["an absent Film is planned", "canonical-film-external-ids-producer.js", "if(!row)return {absent:true", "if(false)return {absent:true"],
 ["ids of every scheme are pruned", "canonical-film-external-ids-producer.js", "stored.filter(item=>content.schemes.includes(item.scheme)&&!want.has(", "stored.filter(item=>!want.has("],
 ["nothing is pruned", "canonical-film-external-ids-producer.js", "&&!want.has(keyOf(item.scheme,item.value))).map", "&&false).map"],
 ["stored ids are rewritten", "canonical-film-external-ids-producer.js", "const add=content.externalIds.filter(item=>!have.has(keyOf(item.scheme,item.value)));", "const add=content.externalIds;"],
 ["the canonical identity id is not protected", "canonical-film-external-ids-producer.js", "if(typeof row.canonical_identity==='string'&&row.canonical_identity.startsWith('tmdb:'))protectedKeys.add(keyOf('tmdb',row.canonical_identity.slice(5)));", ""],
 ["the rated admission id is not protected", "canonical-film-external-ids-producer.js", "if(admission)protectedKeys.add(keyOf('tmdb',admission.tmdb));", ""],
 ["a protected id may be removed", "canonical-film-external-ids-producer.js", "for(const item of remove)if(protectedKeys.has(keyOf(item.scheme,item.value)))throw failed('film_person_identity_conflict');", ""],
 ["another Film's trusted id is not refused", "canonical-film-external-ids-producer.js", "if(await one(db,'SELECT 1 AS x FROM film_external_id WHERE scheme=? AND value=? AND trusted=1 AND conflicting=0 AND film_id<>?',[item.scheme,item.value,input.id]))throw failed('identity_collision');", ""],
 ["an untrusted copy counts as an owner", "canonical-film-external-ids-producer.js", "if(!item.trusted)continue;", ""],
 ["two trusted values of a scheme are accepted", "canonical-film-external-ids-producer.js", "for(const values of trusted.values())if(values.size>1)throw failed('identity_collision');", ""],
 ["a removed trusted id still blocks its replacement", "canonical-film-external-ids-producer.js", "item.conflicting===0&&!gone.has(keyOf(item.scheme,item.value)))trusted.set", "item.conflicting===0)trusted.set"],
 ["nothing is ever a no-op", "canonical-film-external-ids-producer.js", "const noop=add.length===0&&remove.length===0;", "const noop=false;"],
 ["the stored contract version is overwritten", "canonical-film-external-ids-producer.js", "contractVersion:row.contract_version,add,remove}", "contractVersion:99,add,remove}"],
 ["the pre-plan revision is zero", "canonical-film-external-ids-producer.js", "const revision=await revisionOf(db,input.id);", "const revision=0;"],
 ["the batch does not require the Film", "canonical-film-external-ids-producer.js", "requireExisting:true,", ""],
 ["the write has no receipt mark", "canonical-film-external-ids-producer.js", "receiptMark:mark(ctx,clock)});", "});"],
 ["the write drops the removals", "canonical-film-external-ids-producer.js", "removeExternalIds:plan.remove.map(({scheme,value})=>({scheme,value})),", "removeExternalIds:[],"],
 ["a vanished Film is written", "canonical-film-external-ids-producer.js", "if(plan.absent)throw failed('film_person_reference');", ""],
 ["a no-op still writes", "canonical-film-external-ids-producer.js", "if(plan.noop)return {id:input.id,revision:plan.revision,already:true};", ""],
 ["a moved source is replayed", "canonical-film-external-ids-producer.js", "if(!found.ok)throw failed('film_person_invalid');", ""],
 ["a moved source is not abandoned by readback", "canonical-film-external-ids-producer.js", "if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};", ""],
 ["readback never finds the facts", "canonical-film-external-ids-producer.js", "digest:plan?.noop?receipt.contentDigest:null", "digest:null"],
 ["revalidate never supersedes an absent Film", "canonical-film-external-ids-producer.js", "return plan.absent||plan.noop?'superseded':'proceed';", "return plan.noop?'superseded':'proceed';"],
 ["revalidate always proceeds", "canonical-film-external-ids-producer.js", "return plan.absent||plan.noop?'superseded':'proceed';", "return 'proceed';"],
 ["every planner error is a missing plan", "canonical-film-external-ids-producer.js", "if(FILM_EXTERNAL_IDS_REFUSALS.has(error?.code))return null;throw error;", "return null;"],
 ["an identity conflict is not a content refusal", "canonical-film-external-ids-producer.js", "'identity_collision','film_person_identity_conflict']", "'identity_collision']"],
 ["the pass gate ignores the route", "canonical-film-external-ids-producer.js", "if(route.writer!=='canonical')return {state:'skipped'", "if(false)return {state:'skipped'"],
 ["the receipt plans revision zero", "canonical-film-external-ids-producer.js", "expectedRevision:plan.revision,digest", "expectedRevision:0,digest"],
 ["the kind is not in the closed list", "canonical-receipts.js", "'person_mutation','film_external_ids','person_state',", "'person_mutation','person_state',"],
 ["the writer ignores removeExternalIds", "canonical-mutations.js", "for(const item of film.removeExternalIds||[])statements.push(", "for(const item of [])statements.push("],
 ["the writer does not require an existing Film", "canonical-mutations.js", "if(input.requireExisting===true)statements.push(", "if(false)statements.push("]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'film-extids-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-film-external-ids-producer.mjs'],{env:{...process.env,FILM_EXT_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{FILM_EXT_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.FILM_EXT_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-film-external-ids-producer-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
