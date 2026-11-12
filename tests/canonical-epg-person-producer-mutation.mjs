// AIR-374 P3a Person and credit units: mutation check of the dormant EPG Person layer (src/canonical-epg-person-producer.js), its receipt adapters (src/canonical-person-adapters.js), the read-only pre-plan of src/canonical-person-state.js and the new
// operation kind of src/canonical-receipts.js, in the pattern of tests/canonical-epg-producer-mutation.mjs. Each mutant is a copy of the whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/canonical-epg-person-producer.mjs,
// pointed at the copy through EPG_SRC, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

// [name, file in src/, exact text that occurs once, replacement]
const MUTANTS=[
 ["the pass gate ignores the route", "canonical-epg-person-producer.js", "if(!(await producerRouteOpen(env)))return {skipped:true", "if(false)return {skipped:true"],
 ["the pass gate always skips", "canonical-epg-person-producer.js", "if(!(await producerRouteOpen(env)))return {skipped:true", "if(true)return {skipped:true"],
 ["the origin is not epg", "canonical-epg-person-producer.js", "origin:EPG_ORIGIN,event:plan.event,input:unit.input", "origin:'other',event:plan.event,input:unit.input"],
 ["the unit ceiling is lifted", "canonical-epg-person-producer.js", "const cap=epgUnitCap(limit);", "const cap=Number(limit)||1;"],
 ["the unit ceiling has no floor", "canonical-epg-person-producer.js", "const cap=epgUnitCap(limit);", "const cap=Math.min(Number(limit),EPG_UNIT_HARD_CAP);"],
 ["the cursor is ignored", "canonical-epg-person-producer.js", "let index=cursor,stoppedBy=null;", "let index=0,stoppedBy=null;"],
 ["a pass is always done", "canonical-epg-person-producer.js", "done:index>=plan.units.length", "done:true"],
 ["a held marker does not stop the pass", "canonical-epg-person-producer.js", "if(HELD.has(code)){stoppedBy=code;break;}", "if(false){stoppedBy=code;break;}"],
 ["every refusal stops the pass", "canonical-epg-person-producer.js", "if(HELD.has(code)){stoppedBy=code;break;}", "if(true){stoppedBy=code;break;}"],
 ["a refusal blocks the other units", "canonical-epg-person-producer.js", "counts.failed++;failures.push({id:unit.id,code});", "throw error;"],
 ["a refusal is not recorded", "canonical-epg-person-producer.js", "counts.failed++;failures.push({id:unit.id,code});", "counts.failed++;"],
 ["an absent unit is counted a no-op", "canonical-epg-person-producer.js", "if(outcome.state==='absent')counts.absent++;", "if(outcome.state==='absent')counts.noop++;"],
 ["a no-op is counted applied", "canonical-epg-person-producer.js", "else if(outcome.state==='noop')counts.noop++;", "else if(outcome.state==='noop')counts.applied++;"],
 ["an already applied unit is counted applied", "canonical-epg-person-producer.js", "else if(outcome.already===true)counts.already++;", "else if(outcome.already===true)counts.applied++;"],
 ["an unknown outcome is counted failed", "canonical-epg-person-producer.js", "else if(outcome.state==='unknown')counts.unknown++;", "else if(outcome.state==='unknown')counts.failed++;"],
 ["every unit runs as a Person state", "canonical-epg-person-producer.js", "const apply=APPLY_UNIT[unit.kind];", "const apply=APPLY_UNIT.person_state;"],
 ["credits come before Persons", "canonical-epg-person-producer.js", "const units=[...[...people.values()].sort(byId),...[...films.values()].sort(byId)];", "const units=[...[...films.values()].sort(byId),...[...people.values()].sort(byId)];"],
 ["Persons are not sorted", "canonical-epg-person-producer.js", "[...people.values()].sort(byId)", "[...people.values()]"],
 ["Films are not sorted", "canonical-epg-person-producer.js", "[...films.values()].sort(byId)", "[...films.values()]"],
 ["a duplicate Person is accepted", "canonical-epg-person-producer.js", "||people.has(item.id))throw", ")throw"],
 ["a duplicate Film is accepted", "canonical-epg-person-producer.js", "||films.has(item.filmId))throw", ")throw"],
 ["an oversized credit list is accepted", "canonical-epg-person-producer.js", "if(item.credits.length>CREDITS_PER_UNIT_MAX)throw failed('film_person_bounded');", ""],
 ["the run id is not the event", "canonical-epg-person-producer.js", "const event=epgEvent(runId);", "const event='epg:fixed';"],
 ["the write clock is not validated", "canonical-epg-person-producer.js", "if(typeof at!=='string'||!at||", "if("],
 ["a Person state is not validated", "canonical-epg-person-producer.js", "  personStateContent(input);\n", ""],
 ["credits are not normalized", "canonical-epg-person-producer.js", "credits:filmCreditsContent({id:item.filmId,credits:item.credits})", "credits:item.credits"],
 ["the replay ignores the kind", "canonical-epg-person-producer.js", "units.get(receipt?.operation+'\\u0000'+receipt?.target?.id)", "units.get(PERSON_STATE_OPERATION+'\\u0000'+receipt?.target?.id)"],
 ["the replay request id uses the wrong kind", "canonical-epg-person-producer.js", "operation:unit.kind,event:plan.event", "operation:PERSON_STATE_OPERATION,event:plan.event"],
 ["the replay is not bound to the run", "canonical-epg-person-producer.js", "event:plan.event,target:receipt.target,digest:receipt.contentDigest", "event:'epg:fixed',target:receipt.target,digest:receipt.contentDigest"],
 ["the replay does not check the request id", "canonical-epg-person-producer.js", "if(expected!==receipt.requestId)return null;", ""],
 ["the reconcile origin is not epg", "canonical-epg-person-producer.js", "reconcileOwnOrigin(env,{origin:EPG_ORIGIN", "reconcileOwnOrigin(env,{origin:'other'"],
 ["the reconcile does not know Person states", "canonical-epg-person-producer.js", "  [PERSON_STATE_OPERATION,unitOperation(PERSON_STATE_OPERATION,{replan:personReplan,...clock})],\n", ""],
 ["the reconcile does not know credits", "canonical-epg-person-producer.js", "  [FILM_CREDITS_OPERATION,unitOperation(FILM_CREDITS_OPERATION,{replan:personReplan,...clock})],\n", ""],
 ["the reconcile does not know Film facts", "canonical-epg-person-producer.js", "  [FILM_FACTS_OPERATION,filmFactsOperation({replan:epgReplan(filmPlan,env),...clock})],\n", ""],
 ["the reconcile limit is dropped", "canonical-epg-person-producer.js", "...(limit!==undefined?{limit}:{}),...clock,", "...clock,"],
 ["the unit gate ignores the route", "canonical-person-adapters.js", "if(route.writer!=='canonical')return {state:'skipped'", "if(false)return {state:'skipped'"],
 ["the unit gate always skips", "canonical-person-adapters.js", "if(route.writer!=='canonical')return {state:'skipped'", "if(true)return {state:'skipped'"],
 ["the request id has no source event", "canonical-person-adapters.js", "producerRequestId({origin,operation,event,target,digest})", "producerRequestId({origin,operation,event:'epg:fixed',target,digest})"],
 ["a no-op creates a receipt", "canonical-person-adapters.js", "if(plan.noop)return {state:'noop',receipt:false,requestId};", ""],
 ["an absent entity creates a receipt", "canonical-person-adapters.js", "if(plan.absent)return {state:'absent',receipt:false,requestId};", ""],
 ["the write is not atomic", "canonical-person-adapters.js", "atomic:true,\n  readback:hooks.readback,", "atomic:false,\n  readback:hooks.readback,"],
 ["the receipt is planned at revision 0", "canonical-person-adapters.js", "expectedRevision:plan.revision,digest", "expectedRevision:0,digest"],
 ["a Person state without facts is accepted", "canonical-person-adapters.js", "||(!input.person.identity&&!input.person.localization))throw", ")throw"],
 ["a Person state may have a non-person id", "canonical-person-adapters.js", "||!input.id.startsWith('person:')||!plain(input.person)", "||!plain(input.person)"],
 ["the credit bound is lifted", "canonical-person-adapters.js", "input.credits.length>CREDITS_PER_UNIT_MAX", "input.credits.length>1000"],
 ["an unknown role is accepted", "canonical-person-adapters.js", "||!ROLES.has(credit.role))throw", ")throw"],
 ["a duplicate credit is accepted", "canonical-person-adapters.js", "if(seen.has(key))throw failed('film_person_invalid');", ""],
 ["credits are digested in sorted order", "canonical-person-adapters.js", "return out;\n}\nconst CONTENT", "return out.sort((a,b)=>a.personId<b.personId?-1:1);\n}\nconst CONTENT"],
 ["the digest does not bind the target", "canonical-person-adapters.js", "digestOf({operation,id:input?.id,content:content(input)})", "digestOf({operation,content:content(input)})"],
 ["an absent Film is planned as present", "canonical-person-adapters.js", "if(!film)return {absent:true", "if(false)return {absent:true"],
 ["a redirected Film is written", "canonical-person-adapters.js", "if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[input.id]))throw failed('film_person_redirect');", ""],
 ["a stored credit of another role counts as stored", "canonical-person-adapters.js", "!have.has(keyOf(credit.personId,credit.role))", "!have.has(keyOf(credit.personId,'actor'))"],
 ["every credit is missing", "canonical-person-adapters.js", "credits.filter(credit=>!have.has(", "credits.filter(credit=>true||!have.has("],
 ["a missing credit Person is not refused", "canonical-person-adapters.js", "if(ids.some(id=>!found.has(id)))throw failed('film_person_reference');", ""],
 ["the Film contract version is overwritten", "canonical-person-adapters.js", "film:{contractVersion:snapshot.contractVersion}", "film:{contractVersion:1}"],
 ["a credit write with nothing missing still writes", "canonical-person-adapters.js", "if(snapshot.noop)return {id:input.id,revision:snapshot.revision,already:true};", ""],
 ["a vanished Film is written", "canonical-person-adapters.js", "if(snapshot.absent)throw failed('film_person_reference');", ""],
 ["a moved source is not abandoned by readback", "canonical-person-adapters.js", "if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};", ""],
 ["readback never finds the facts", "canonical-person-adapters.js", "digest:plan?.noop?receipt.contentDigest:null", "digest:null"],
 ["a moved source is replayed", "canonical-person-adapters.js", "if(!found.ok)throw failed('film_person_invalid');", ""],
 ["a missing re-plan is replayed", "canonical-person-adapters.js", "if(!found)throw failed('producer_replan_unavailable');", "if(!found)return null;"],
 ["revalidate always proceeds", "canonical-person-adapters.js", "return plan.absent||plan.noop?'superseded':'proceed';", "return 'proceed';"],
 ["revalidate never supersedes an absent entity", "canonical-person-adapters.js", "return plan.absent||plan.noop?'superseded':'proceed';", "return plan.noop?'superseded':'proceed';"],
 ["revalidate ignores a missing re-plan", "canonical-person-adapters.js", "if(!found||!found.ok)return 'stale';", "if(!found)return 'stale';"],
 ["the replay write clock is dropped", "canonical-person-adapters.js", "return spec.write(env,found.input,receipt.requestId,ctx,now);", "return spec.write(env,found.input,receipt.requestId,ctx,()=>'x');"],
 ["the pre-plan treats an absent Person as present", "canonical-person-state.js", "const revision=await currentRevision(db,'person',id);\n if(!(await one(db,'SELECT 1 AS x FROM person WHERE id=?',[id])))return {absent:true", "const revision=await currentRevision(db,'person',id);\n if(false)return {absent:true"],
 ["the pre-plan never finds a no-op", "canonical-person-state.js", "noop:await personStateSatisfied(db,id,plan,stored),revision}", "noop:false,revision}"],
 ["the pre-plan always finds a no-op", "canonical-person-state.js", "noop:await personStateSatisfied(db,id,plan,stored),revision}", "noop:true,revision}"],
 ["the pre-plan reports revision 0", "canonical-person-state.js", "const revision=await currentRevision(db,'person',id);\n if(!(await", "const revision=0;\n if(!(await"],
 ["the film_credits kind is not registered", "canonical-receipts.js", "'film_facts','film_credits',", "'film_facts',"],
 ["the event helper is another namespace", "canonical-epg-producer.js", "export const epgEvent=eventOf;", "export const epgEvent=runId=>eventOf(runId)+'x';"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epg-person-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-epg-person-producer.mjs'],{env:{...process.env,EPG_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
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
 console.log('canonical-epg-person-producer-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
