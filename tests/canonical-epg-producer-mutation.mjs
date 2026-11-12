// AIR-374 P3a: mutation check of the dormant EPG producer layer (src/canonical-epg-producer.js) and the route helper of src/canonical-producer-adapters.js, in the pattern of tests/canonical-film-writers-mutation.mjs. Each mutant is a copy of the whole src/ directory with ONE
// rule removed or inverted in ONE file; tests/canonical-epg-producer.mjs, pointed at the copy through EPG_SRC, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant
// that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards), so one can never be committed. Four at a time, one shared template database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

// [name, file in src/, exact text that occurs once, replacement]
const MUTANTS=[
 ["the gate ignores the route", "canonical-epg-producer.js", "if(!(await producerRouteOpen(env)))return {skipped:true", "if(false)return {skipped:true"],
 ["the gate always skips", "canonical-epg-producer.js", "if(!(await producerRouteOpen(env)))return {skipped:true", "if(true)return {skipped:true"],
 ["the route helper is always open", "canonical-producer-adapters.js", "return (await writerRoute(env)).writer==='canonical';", "await writerRoute(env);return true;"],
 ["the route helper is never open", "canonical-producer-adapters.js", "return (await writerRoute(env)).writer==='canonical';", "await writerRoute(env);return false;"],
 ["the origin is not epg", "canonical-epg-producer.js", "export const EPG_ORIGIN='epg';", "export const EPG_ORIGIN='other';"],
 ["the hard cap is lifted", "canonical-epg-producer.js", "Math.min(Math.max(Number(limit)||1,1),EPG_UNIT_HARD_CAP)", "Math.max(Number(limit)||1,1)"],
 ["the cap floor is removed", "canonical-epg-producer.js", "Math.min(Math.max(Number(limit)||1,1),EPG_UNIT_HARD_CAP)", "Math.min(Number(limit),EPG_UNIT_HARD_CAP)"],
 ["the hard cap exceeds the budget", "canonical-epg-producer.js", "export const EPG_UNIT_HARD_CAP=50;", "export const EPG_UNIT_HARD_CAP=500;"],
 ["the default exceeds the ceiling", "canonical-epg-producer.js", "export const EPG_UNIT_LIMIT_DEFAULT=25;", "export const EPG_UNIT_LIMIT_DEFAULT=250;"],
 ["the pass ignores the cursor", "canonical-epg-producer.js", "let index=cursor,stoppedBy=null;", "let index=0,stoppedBy=null;"],
 ["the pass ignores the limit", "canonical-epg-producer.js", "index-cursor<cap;index++", "index<plan.units.length;index++"],
 ["done is always true", "canonical-epg-producer.js", "done:index>=plan.units.length", "done:true"],
 ["a held marker does not stop the pass", "canonical-epg-producer.js", "if(HELD.has(code)){stoppedBy=code;break;}", "if(false){stoppedBy=code;break;}"],
 ["an unreadable marker does not stop the pass", "canonical-epg-producer.js", "const HELD=new Set(['film_person_held','film_person_unavailable']);", "const HELD=new Set(['film_person_held']);"],
 ["a refusal stops the whole pass", "canonical-epg-producer.js", "counts.failed++;failures.push({id:unit.id,code});", "counts.failed++;failures.push({id:unit.id,code});break;"],
 ["a refusal is not recorded", "canonical-epg-producer.js", "counts.failed++;failures.push({id:unit.id,code});", "counts.failed++;"],
 ["a release creates a missing Film", "canonical-epg-producer.js", "if(!input){counts.absent++;continue;}", "if(!input){input={...unit.input,film:{contractVersion:1}};}"],
 ["every release is skipped", "canonical-epg-producer.js", "if(!input){counts.absent++;continue;}", "if(true){counts.absent++;continue;}"],
 ["a release does not clear membership", "canonical-epg-producer.js", "input:{id,at,release:true,watchlist:false}", "input:{id,at,release:true,watchlist:true}"],
 ["a release overwrites the stored contract version", "canonical-producer-adapters.js", "film:{contractVersion:snapshot.film.contract_version},updatedAt", "film:{contractVersion:1},updatedAt"],
 ["a release touches the Film clock", "canonical-producer-adapters.js", "updatedAt:snapshot.film.updated_at||input.at}", "updatedAt:input.at}"],
 ["a release existence test is the plan change", "canonical-producer-adapters.js", "if(!snapshot.film||!Number.isInteger(snapshot.film.contract_version))return null;", "if(!snapshot.film||snapshot.film.contract_version!==1)return null;"],
 ["a release digest includes the Film facts", "canonical-producer-adapters.js", "if(input.release===true)return {release:true,watchlist:input.watchlist};", ""],
 ["the replay is not bound to the run event", "canonical-epg-producer.js", "if(expected!==receipt.requestId)return null;", ""],
 ["the replay binds to a fixed event", "canonical-epg-producer.js", "event:plan.event,target:receipt.target,digest:receipt.contentDigest", "event:'epg:run-A',target:receipt.target,digest:receipt.contentDigest"],
 ["the replay ignores the receipt digest", "canonical-epg-producer.js", "target:receipt.target,digest:receipt.contentDigest}", "target:receipt.target,digest:'0'.repeat(64)}"],
 ["a release re-plans without the store", "canonical-epg-producer.js", "return env?resolveReleaseInput(env,unit.input):null;", "return unit.input;"],
 ["reconcile does not give the store to the re-plan", "canonical-epg-producer.js", "replan:epgReplan(plan,env),", "replan:epgReplan(plan),"],
 ["a departed member that is observed is released", "canonical-epg-producer.js", "if(units.has(id))continue;", "if(false)continue;"],
 ["duplicates are accepted", "canonical-epg-producer.js", "||!plain(item.facts)||units.has(item.id))throw", "||!plain(item.facts))throw"],
 ["the units are not sorted", "canonical-epg-producer.js", ".sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)", ""],
 ["the sort is descending", "canonical-epg-producer.js", "a.id<b.id?-1:a.id>b.id?1:0", "a.id<b.id?1:a.id>b.id?-1:0"],
 ["caller clocks survive", "canonical-epg-producer.js", "const {id:_id,at:_at,requestId:_r,expectedRevision:_e,receiptMark:_m,...facts}=item.facts;", "const facts=item.facts;"],
 ["the run clock is not applied", "canonical-epg-producer.js", "input:{...facts,id:item.id,at}}", "input:{...facts,id:item.id}}"],
 ["the run id is not required", "canonical-epg-producer.js", "if(typeof runId!=='string'||!runId.trim()||runId.length>280)throw failed('film_person_invalid');", "if(typeof runId!=='string')throw failed('film_person_invalid');"],
 ["the run id is not bounded", "canonical-epg-producer.js", "||runId.length>280)", "||false)"],
 ["the event is not namespaced", "canonical-epg-producer.js", "return 'epg:'+runId;", "return runId;"],
 ["the clock is not required", "canonical-epg-producer.js", "if(typeof at!=='string'||!at||!Array.isArray(films)", "if(!Array.isArray(films)"],
 ["departed ids are not validated", "canonical-epg-producer.js", "if(typeof id!=='string'||!id.startsWith('film:'))throw failed('film_person_invalid');\n  if(units.has(id))continue;", "if(units.has(id))continue;"],
 ["film ids are not validated", "canonical-epg-producer.js", "typeof item.id!=='string'||!item.id.startsWith('film:')||!plain(item.facts)", "!plain(item.facts)"],
 ["the re-plan ignores the Film", "canonical-epg-producer.js", "const unit=byId.get(receipt?.target?.id);", "const unit=[...byId.values()][0];"],
 ["the re-plan is always empty", "canonical-epg-producer.js", "if(!unit||typeof plan?.event!=='string')return null;", "return null;"],
 ["reconcile uses another origin", "canonical-epg-producer.js", "reconcileOwnOrigin(env,{origin:EPG_ORIGIN,", "reconcileOwnOrigin(env,{origin:'discovery',"],
 ["reconcile drops the origin", "canonical-epg-producer.js", "reconcileOwnOrigin(env,{origin:EPG_ORIGIN,operations", "reconcileOwnOrigin(env,{origin:undefined,operations"],
 ["reconcile drops the limit", "canonical-epg-producer.js", "...(limit!==undefined?{limit}:{}),", ""],
 ["reconcile drops the plan", "canonical-epg-producer.js", "filmFactsOperation({replan:epgReplan(plan,env),", "filmFactsOperation({replan:async()=>null,"],
 ["the unit does not use the run event", "canonical-epg-producer.js", "event:plan.event,input,", "event:'fixed',input,"],
 ["noop is counted as applied", "canonical-epg-producer.js", "if(outcome.state==='noop')counts.noop++;", "if(outcome.state==='noop')counts.applied++;"],
 ["already is not counted", "canonical-epg-producer.js", "else if(outcome.already===true)counts.already++;", "else if(outcome.already===true){/* lost */}"],
 ["an unknown outcome is counted applied", "canonical-epg-producer.js", "else if(outcome.state==='unknown')counts.unknown++;", "else if(outcome.state==='unknown')counts.applied++;"],
 ["the cursor is malformed-tolerant", "canonical-epg-producer.js", "||!Number.isInteger(cursor)||cursor<0)throw", "||false)throw"],
 ["a plan without an event is accepted", "canonical-epg-producer.js", "typeof plan.event!=='string'||", ""]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epg-producer-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-epg-producer.mjs'],{env:{...process.env,EPG_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
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
 console.log('canonical-epg-producer-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
