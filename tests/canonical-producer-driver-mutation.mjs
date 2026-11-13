// AIR-374 S4-4: mutation check of the dormant producer driver (src/canonical-producer-driver.js) and of the store additions it needs (src/canonical-producer-store.js), in the pattern of tests/canonical-producer-store-mutation.mjs. Each mutant is a copy of the
// whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/canonical-producer-driver.mjs, pointed at the copy through DRIVER_SRC, must FAIL on it. The test body is NOT cheap (a sqlite3 process per statement), so every mutant runs in its OWN
// process (per-call fixture isolation: no module-scoped fixture is shared between two runs, which is what gave false kills in the in-process runner of the first mutation checks).
// Controls: the unmutated test is run TWICE and must pass both times (the baseline is stable), and a NEUTRAL mutant (a comment appended to the driver) must SURVIVE (the harness does not kill everything). A surviving mutant is a rule no test depends on; a mutant that
// does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const DRIVER='canonical-producer-driver.js',STORE='canonical-producer-store.js';
const SKIP="return {state:'skipped',reason:'projector_is_writer'};";
const MUTANTS=[
 ["a deadline above the step lease is accepted", DRIVER, "intIn(params.sliceDeadlineMs,1,MAX_DEADLINE_MS)", "intIn(params.sliceDeadlineMs,1,1e9)"],
 ["the lease margin is dropped", DRIVER, "export const MAX_DEADLINE_MS=STEP_LEASE_MS-STEP_LEASE_MARGIN_MS;", "export const MAX_DEADLINE_MS=STEP_LEASE_MS;"],
 ["the slice size has a default", DRIVER, "if(!intIn(params.sliceSize,1,EPG_UNIT_HARD_CAP))return 'sliceSize';", ""],
 ["the slice size may exceed the hard cap", DRIVER, "intIn(params.sliceSize,1,EPG_UNIT_HARD_CAP)", "intIn(params.sliceSize,1,1e9)"],
 ["maxSlicesPerRun has a default", DRIVER, "if(!intIn(params.maxSlicesPerRun,1,MAX_SLICES_CEILING))return 'maxSlicesPerRun';", ""],
 ["the prerequisite reader is optional", DRIVER, "if(typeof params.prerequisites!=='function')return 'prerequisites';", ""],
 ["the retry limit has a default", DRIVER, "return intIn(params.limit,1,DUE_LIMIT_MAX)?null:'limit';", "return null;"],
 ["the pass ignores the marker gate", DRIVER, "if(!(await producerRouteOpen(env)))"+SKIP+"\n  const plan=await buildEpgPlan(env,params);", "const plan=await buildEpgPlan(env,params);"],
 ["the retry ignores the marker gate", DRIVER, "if(!(await producerRouteOpen(env)))"+SKIP+"\n  const clock=clockOf(params),now=nowOf(params),t0=clock();", "const clock=clockOf(params),now=nowOf(params),t0=clock();"],
 ["the dictionary pass ignores the marker gate", DRIVER, "if(!(await producerRouteOpen(env)))"+SKIP+"\n  const resolved=[],refused=[];", "const resolved=[],refused=[];"],
 ["a skipped answer of a layer is not a stop", DRIVER, "if(result.skipped===true)return {type:'stop',code:'film_person_not_open'};", ""],
 ["a held code of a layer is not a stop", DRIVER, "if(result.stoppedBy!==null&&result.stoppedBy!==undefined)return typeof result.stoppedBy==='string'&&result.stoppedBy?{type:'stop',code:codeOf(result.stoppedBy)}:MALFORMED;", ""],
 ["the failures of a layer are ignored", DRIVER, "if(key==='failed')return failures.length===1?{type:'failed',error:{code:failures[0].code}}:{type:'stop',code:'receipt_state_conflict'};", "if(key==='failed')return {type:'stop',code:'receipt_state_conflict'};"],
 ["an unresolved receipt lets the cursor pass", DRIVER, "if(key==='unknown'||key==='pending')return {type:'stop',code:'receipt_state_conflict'};", ""],
 ["a redirected Film is not a refusal", DRIVER, "if(key==='redirected')return {type:'failed',error:{code:'film_person_redirect'}};", ""],
 ["an already applied unit is not counted applied", DRIVER, "if(key==='applied'||key==='already')return", "if(key==='applied')return"],
 ["the immediate re-plan is skipped", DRIVER, "if(verdict.type==='failed'&&classifyProducerError(verdict.error).replanFirst)", "if(false)"],
 ["a planner refusal is applied instead of recorded", DRIVER, "if(entry.refusal!==undefined)return {type:'failed',error:{code:entry.refusal}};", ""],
 ["the strike is committed before the prefix of the slice", DRIVER, "await flush();\n     const answer=await commitStrike(", "const answer=await commitStrike("],
 ["a success does not fold into the strike state", DRIVER, "folded={...folded,...strikeStep(folded,{type:'unit_done',unit}).run};", "folded={...folded,cursor_kind:unit.kind,cursor_id:unit.id};"],
 ["every success counts as applied", DRIVER, "pending.counts[verdict.outcome==='applied'?'applied':verdict.outcome==='noop'?'noop':'kept']++;", "pending.counts.applied++;"],
 ["a kept outcome leaves a result", DRIVER, "if(step.action==='unit_done'){folded={...folded,...step.run};pending.counts.kept++;pending.last=unit;index++;inSlice++;continue;}", ""],
 ["a stop drops the durable prefix of the slice", DRIVER, "if(verdict.type==='stop'){await flush();return await stop(verdict.code);}", "if(verdict.type==='stop'){return await stop(verdict.code);}"],
 ["a unit step failure drops the durable prefix", DRIVER, "if(!commitFailed)await flush().catch(()=>{});", ""],
 ["a stop retries the slice commit that failed", DRIVER, "if(!commitFailed)await flush().catch(()=>{});", "await flush().catch(()=>{});"],
 ["the recoverable stamp is not computed", DRIVER, "const stamp=result.state==='refused_recoverable'?await stampFor(env,ctx,entry,result.code):null;", "const stamp=null;"],
 ["the live result is not looked up", DRIVER, "const live=await liveResult(env,{origin:ctx.origin,runKey:run.run_key,kind:unit.kind,unitId:unit.id});", "const live=null;"],
 ["the statement cap is not respected", DRIVER, "if(pending.cost+cost>SLICE_STATEMENT_CAP)await flush();", ""],
 ["the deadline is ignored", DRIVER, "if(clock()-t0>=params.sliceDeadlineMs){deadlineHit=true;break;}", ""],
 ["maxSlicesPerRun is ignored", DRIVER, "slices<params.maxSlicesPerRun&&", ""],
 ["a stopped run is not taken over", DRIVER, "if(run.pass_state==='stopped'){", "if(false){"],
 ["an incomplete pass claims completion", DRIVER, "if(index<entries.length)return {...base(),state:'partial'", "if(false)return {...base(),state:'partial'"],
 ["the open results are not counted at completion", DRIVER, "commitPassComplete(env,{run,openAtCompletion:open,", "commitPassComplete(env,{run,openAtCompletion:0,"],
 ["a completed run is run again", DRIVER, "if(opened.run.pass_state==='passed'&&opened.run.applied_generation!==null)return", "if(false)return"],
 ["a resume starts at the first unit", DRIVER, "startIndex:opened.startIndex,absent:plan.absent,", "startIndex:0,absent:plan.absent,"],
 ["a release of an unstored Film stays in the plan", DRIVER, "if(!digestInput){absent++;continue;}", ""],
 ["an error message reaches the caller", DRIVER, "const errorResult=(error,extra={})=>({state:'error',code:codeOf(error),...extra});", "const errorResult=(error,extra={})=>({state:'error',code:codeOf(error),message:String(error?.message),...extra});"],
 ["the EPG pass lets an exception out", DRIVER, "applyOptions:applyOptionsOf(params)});\n }catch(error){return errorResult(error);}\n}\n\n// ---------------------------------------------------------------------------------------------------------------------------------\n// The dictionary pass", "applyOptions:applyOptionsOf(params)});\n }catch(error){throw error;}\n}\n\n// ---------------------------------------------------------------------------------------------------------------------------------\n// The dictionary pass"],
 ["the retry pass lets an exception out", DRIVER, "return {state:stopCode?'stopped':'done',...(stopCode?{code:stopCode}:{}),counts,reconcile};\n }catch(error){return errorResult(error);}", "return {state:stopCode?'stopped':'done',...(stopCode?{code:stopCode}:{}),counts,reconcile};\n }catch(error){throw error;}"],
 ["a superseded or abandoned result is not settled", DRIVER, "if(decision.action==='supersede'||decision.action==='abandon'){", "if(decision.action==='supersede'){"],
 ["a deferred schedule is not stored", DRIVER, "if(decision.action==='defer'){await updateResult(env,{row,patch:decision.patch,at:now()});counts.deferred++;continue;}", "if(decision.action==='defer'){counts.deferred++;continue;}"],
 ["an unproven outcome settles the result", DRIVER, ":verdict.outcome==='noop'?{kind:'proof',proof:'verified_noop'}:{kind:'not_proven'};", ":verdict.outcome==='noop'?{kind:'proof',proof:'verified_noop'}:{kind:'proof',proof:'verified_noop'};"],
 ["a systemic failure of the retry does not stop it", DRIVER, "if(verdict.type==='stop'){stopCode=verdict.code;break;}", "if(verdict.type==='stop'){break;}"],
 ["the retry does not read the current stamp", DRIVER, "const stamp=row.state==='refused_recoverable'&&entry!==null&&entry.unitDigest===row.unit_digest?await stampFor(env,ctx,{kind:row.kind,id:row.unit_id},row.code):undefined;", "const stamp=undefined;"],
 ["a retry reclassification is not stored", DRIVER, "else if(next.action==='update'){await updateResult(env,{row,patch:next.patch,at:now()});counts.updated++;}", "else if(next.action==='update'){counts.updated++;}"],
 ["an owner-review check that cannot run does not stop the pass", DRIVER, "if(guard.decision==='stop')return {state:'stopped',code:guard.code,recorded:false,minted:false};", ""],
 ["an unverifiable owner-reviewed Film reaches the writer", DRIVER, "if(guard.decision==='refuse'){refused.push({kind:'film_facts',id:found.filmId,code:guard.code,source:entry});continue;}", ""],
 ["a resolver refusal is ignored", DRIVER, "if(plain(found)&&typeof found.refusal==='string'){", "if(false){"],
 ["a reused dictionary version of another plan is resumed", DRIVER, "if(minted.run.fingerprint!==fingerprint)return {state:'stopped',code:'producer_cas_lost',recorded:false,minted:false};", ""],
 ["a membership reader accepts a partial canonical state", DRIVER, "return state.freshness==='current'?{ok:true,freshness:'current'}", "return state.freshness==='current'||state.freshness==='partial'?{ok:true,freshness:'current'}"],
 ["the live results are left out of freshness", DRIVER, "liveFilmFactsResults:live}", "liveFilmFactsResults:0}"],
 ["an unreadable store is not unknown", DRIVER, "return {freshness:'unknown',publishedGeneration:publishedGeneration??null,appliedGeneration:null,passState:null,code:codeOf(error)};", "return {freshness:'current',publishedGeneration:publishedGeneration??null,appliedGeneration:null,passState:null,code:codeOf(error)};"],
 ["a reply that is not an object is believed", DRIVER, "if(!plain(result))return MALFORMED;\n if(result.skipped===true)", "if(result.skipped===true)"],
 ["a reply without an explicit skipped flag is believed", DRIVER, "if(result.skipped!==false)return MALFORMED;", ""],
 ["a reply that did not visit the unit is believed", DRIVER, "||result.cursor!==1||result.done!==true)return MALFORMED;", ")return MALFORMED;"],
 ["a reply with an invalid count is believed", DRIVER, "if(entries.some(([,value])=>!Number.isInteger(value)||value<0))return MALFORMED;", ""],
 ["a reply with no or several outcomes is believed", DRIVER, "if(named.length!==1||named[0][1]!==1)return MALFORMED;", ""],
 ["a reply with contradictory failures is believed", DRIVER, "if(failures.length>1||failures.some(item=>!plain(item)||typeof item.code!=='string'||!item.code))return MALFORMED;", ""],
 ["a failure listed beside a success is believed", DRIVER, "if(failures.length)return MALFORMED;\n if(key==='applied'", "if(key==='applied'"],
 ["an unknown outcome counts as kept", DRIVER, "if(key==='unknown'||key==='pending')return {type:'stop',code:'receipt_state_conflict'};\n return MALFORMED;", "if(key==='unknown'||key==='pending')return {type:'stop',code:'receipt_state_conflict'};\n return {type:'done',outcome:'kept'};"],
 ["a named kept outcome is refused", DRIVER, "const KEPT_COUNTS=Object.freeze(['absent','kept','identity_mismatch']);", "const KEPT_COUNTS=Object.freeze([]);"],
 ["a malformed stop code is believed", DRIVER, "return typeof result.stoppedBy==='string'&&result.stoppedBy?{type:'stop',code:codeOf(result.stoppedBy)}:MALFORMED;", "return {type:'stop',code:codeOf(result.stoppedBy)};"],
 ["the retry selection is not limited to its origin", DRIVER, "limit:params.limit,origin:'epg'});", "limit:params.limit});"],
 ["the origin filter is dropped in SQL", STORE, "(origin?' AND origin=?':'')+\" AND state IN ('open','refused_recoverable')", "''+\" AND state IN ('open','refused_recoverable')"],
 ["an unknown origin is accepted by the selection", STORE, "||(origin!==undefined&&!ORIGINS.includes(origin)))throw invalid();", ")throw invalid();"],
 ["an earlier generation is never superseded", DRIVER, "const sweep=await supersedeEarlierResults(env,{run,entries,now,maxPages:Number.isInteger(params.supersedeMaxPages)&&params.supersedeMaxPages>=1?params.supersedeMaxPages:SUPERSEDE_MAX_PAGES});", "const sweep={complete:true,superseded:0};"],
 ["an uncovered earlier result is superseded", DRIVER, "if(!covered.has(keyOf({kind:row.kind,id:row.unit_id})))continue;", ""],
 ["the supersession is not named newer_run", DRIVER, "settledBy:'newer_run'", "settledBy:'applied'"],
 ["an unfinished sweep claims completion", DRIVER, "if(!sweep.complete)return {...base(),state:'partial',reason:'supersession_pending'", "if(false)return {...base(),state:'partial',reason:'supersession_pending'"],
 ["only the first page of earlier results is swept", DRIVER, "if(rows.length<SUPERSEDE_PAGE)return {complete:true,superseded};", "return {complete:true,superseded};"],
 ["the earlier results include the run itself", STORE, "AND run_key<>? AND retry_owner='unit'", "AND run_key=? AND retry_owner='unit'"],
 ["a receipt-owned earlier result is offered", STORE, "AND run_key<>? AND retry_owner='unit' AND state IN (", "AND run_key<>? AND state IN ("],
 ["a result update may lower the attempts", STORE, "||next.attempts<row.attempts)throw invalid();", ")throw invalid();"],
 ["a result update may move a terminal state", STORE, "!LIVE_STATES.includes(next.state)||", ""],
 ["a result update ignores the route gate", STORE, "const gate=await routeOf(env);\n if(!gate.open)return SKIPPED;\n const key=keyOfRow(row);\n await commit(env,gate,[fence(gate),\n  ['UPDATE canonical_producer_unit_result SET state=?,code=?,attempts=?,prereq_stamp=?,next_attempt_at=?,updated_at=?", "const gate=await routeOf(env);\n const key=keyOfRow(row);\n await commit(env,gate,[fence(gate),\n  ['UPDATE canonical_producer_unit_result SET state=?,code=?,attempts=?,prereq_stamp=?,next_attempt_at=?,updated_at=?"],
 ["a resume of a run that is not stopped is accepted", STORE, "run.pass_state!=='stopped'||typeof at!=='string')throw invalid();", "typeof at!=='string')throw invalid();"],
 ["a resume touches the cursor", STORE, "SET pass_state='passing',stopped_by=NULL,revision=revision+1", "SET pass_state='passing',stopped_by=NULL,cursor_kind=NULL,cursor_id=NULL,revision=revision+1"],
 ["the membership count includes every kind", STORE, "WHERE origin='epg' AND kind='film_facts' AND state IN (", "WHERE origin='epg' AND state IN ("],
 ["the latest run is the oldest", STORE, "ORDER BY created_at DESC,run_key DESC LIMIT 1\"))||null;}\n catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}\n}\n// S4-4: the LIVE results of origin", "ORDER BY created_at ASC,run_key ASC LIMIT 1\"))||null;}\n catch(error){throw /no such table/i.test(String(error?.message))?failed('producer_store_missing',error):failed('producer_run_unreadable',error);}\n}\n// S4-4: the LIVE results of origin"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'producer-driver-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once; every run copies it.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=env=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-producer-driver.mjs'],{env:{...process.env,DRIVER_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 const copyOf=(index,file,to)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  if(file)fs.writeFileSync(path.join(copy,file),to);
  return copy;
 };
 // Controls: the baseline passes twice, and a neutral mutant (a comment) survives.
 const [first,second]=await Promise.all([run({}),run({})]);
 assert.equal(first,0,'the unmutated test passes');assert.equal(second,0,'the unmutated test passes again (a stable baseline)');
 const neutral=copyOf('neutral',DRIVER,text(DRIVER)+'\n// neutral control\n');
 assert.equal(await run({DRIVER_SRC:neutral}),0,'a neutral mutant is not killed');
 fs.rmSync(neutral,{recursive:true,force:true});
 const queue=MUTANTS.map(([name,file,from,to],index)=>({name,env:{DRIVER_SRC:copyOf(index,file,text(file).replace(from,()=>to))}}));
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.DRIVER_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-producer-driver-mutation: ok ('+MUTANTS.length+' mutants killed, baseline stable, neutral control survived)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
