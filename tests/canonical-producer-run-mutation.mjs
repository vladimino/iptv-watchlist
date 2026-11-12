// AIR-374 S4-1 (ADR 0128): mutation check of the pure producer-run module (src/canonical-producer-run.js). Each mutant removes or inverts ONE safety rule in a copy of that one file; tests/canonical-producer-run.mjs, pointed at the copy through
// RUN_SRC, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copy lives OUTSIDE the repository tree: a temporary directory holding the mutated file and symlinks to every other file of
// src/, so the receipt helpers it imports are the real ones. The module is pure and small, so the whole check stays in the seconds.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE='canonical-producer-run.js';
// [name, exact text that occurs once, replacement]
const MUTANTS=[
 // classification
 ["film_person_unavailable becomes a unit failure", "'film_person_unavailable','film_person_held',", "'film_person_held',"],
 ["film_person_held becomes a unit failure", "'film_person_held','film_person_not_open',", "'film_person_not_open',"],
 ["film_person_fence becomes a unit failure", "'film_person_fence','film_person_run_mismatch',", "'film_person_run_mismatch',"],
 ["a lost compare-and-set is no systemic code", "'producer_cas_lost',", ""],
 ["a failed slice commit is no systemic code", "'producer_slice_commit_failed',", ""],
 ["a failed strike commit is no systemic code", "'producer_strike_commit_failed',", ""],
 ["a missing store is no systemic code", "'producer_store_missing',", ""],
 ["an unreadable check is no systemic code", "'owner_review_check_failed',\n ]),", "]),"],
 ["a collision is no unit failure", "'identity_collision','person_role_collision',", "'person_role_collision',"],
 ["a role collision is no unit failure", "'person_role_collision','credit_ordinal_conflict',", "'credit_ordinal_conflict',"],
 ["an ordinal conflict is no unit failure", "'credit_ordinal_conflict','film_person_identity_conflict',", "'film_person_identity_conflict',"],
 ["a revision conflict is no unit failure", "rows(CLASS.UNIT,['film_person_revision_conflict','film_person_precondition',", "rows(CLASS.UNIT,['film_person_precondition',"],
 ["an invalid input is recoverable", "rows(CLASS.PERMANENT,['film_person_invalid','film_person_bounded',", "rows(CLASS.RECOVERABLE,['film_person_invalid','film_person_bounded',"],
 ["the credit bound is recoverable", "'film_person_invalid','film_person_bounded','dictionary_source_ambiguous'", "'film_person_invalid','dictionary_source_ambiguous'"],
 ["source ambiguity is recoverable", ",'dictionary_source_ambiguous']),", "]),"],
 ["a missing identity row is permanent", "rows(CLASS.RECOVERABLE,['no_identity_row',", "rows(CLASS.PERMANENT,['no_identity_row',"],
 ["a missing Person is no recoverable refusal", "'film_person_reference','film_person_redirect',", "'film_person_redirect',"],
 ["canonical ambiguity is permanent", "'dictionary_identity_ambiguous','owner_review_inconsistent'", "'owner_review_inconsistent'"],
 ["an unranked title is no kept outcome", "'owner_kept','reviewed_kept','unranked_kept',", "'owner_kept','reviewed_kept',"],
 ["an unknown code is systemic", "?ERROR_CLASSES[code]:CLASS.UNCLASSIFIED;", "?ERROR_CLASSES[code]:CLASS.SYSTEMIC;"],
 ["an unknown code is a unit failure", "?ERROR_CLASSES[code]:CLASS.UNCLASSIFIED;", "?ERROR_CLASSES[code]:CLASS.UNIT;"],
 ["a prototype name is a code", "Object.hasOwn(ERROR_CLASSES,code)?", "(code in ERROR_CLASSES)?"],
 ["an error without a code is a unit failure", ":'film_person_unavailable';\n const cls", ":'identity_collision';\n const cls"],
 ["unclassified does not stop", "[CLASS.UNCLASSIFIED]:'stop',", "[CLASS.UNCLASSIFIED]:'strike',"],
 ["the replan-first set is empty", "new Set(['film_person_revision_conflict','film_person_precondition'])", "new Set([])"],
 // strikes
 ["the strike limit is 4", "export const STRIKE_LIMIT=3;", "export const STRIKE_LIMIT=4;"],
 ["the strike limit is 2", "export const STRIKE_LIMIT=3;", "export const STRIKE_LIMIT=2;"],
 ["a failure does not count on the same identity", "const count=sameIdentity(strike,identity)&&strike.strike_count>0?strike.strike_count+1:1;", "const count=1;"],
 ["a new identity continues the old count", "const count=sameIdentity(strike,identity)&&strike.strike_count>0?strike.strike_count+1:1;", "const count=strike.strike_count>0?strike.strike_count+1:1;"],
 ["the digest is not part of the identity", "a.strike_id===b.strike_id&&a.strike_digest===b.strike_digest&&a.strike_class===b.strike_class;", "a.strike_id===b.strike_id&&a.strike_class===b.strike_class;"],
 ["the class is not part of the identity", "a.strike_digest===b.strike_digest&&a.strike_class===b.strike_class;", "a.strike_digest===b.strike_digest;"],
 ["the unit is not part of the identity", "a.strike_kind===b.strike_kind&&a.strike_id===b.strike_id&&a.strike_digest===b.strike_digest&&a.strike_class===b.strike_class;", "a.strike_kind===b.strike_kind&&a.strike_digest===b.strike_digest&&a.strike_class===b.strike_class;"],
 ["the third strike does not clear the identity", "return {action:'third_strike',run:{...run,...NO_STRIKE,...keyFields(unit)}", "return {action:'third_strike',run:{...run,...keyFields(unit)}"],
 ["the third strike does not advance the cursor", "return {action:'third_strike',run:{...run,...NO_STRIKE,...keyFields(unit)}", "return {action:'third_strike',run:{...run,...NO_STRIKE}"],
 ["the third strike carries no attempts", "result:{state:'open',code:verdict.code,attempts:STRIKE_LIMIT}", "result:{state:'open',code:verdict.code,attempts:1}"],
 ["a strike moves the cursor", "return {action:'strike',run:{...run,...identity,strike_count:count}};", "return {action:'strike',run:{...run,...identity,strike_count:count,...keyFields(unit)}};"],
 ["a systemic stop clears the strike", "return {action:'stop',run:{...run,pass_state:'stopped',stopped_by:code}};", "return {action:'stop',run:{...run,...NO_STRIKE,pass_state:'stopped',stopped_by:code}};"],
 ["a systemic stop adds a strike", "return {action:'stop',run:{...run,pass_state:'stopped',stopped_by:code}};", "return {action:'stop',run:{...run,strike_count:Math.min(run.strike_count+1,2),strike_id:run.strike_id,pass_state:'stopped',stopped_by:code}};"],
 ["a systemic stop records no cause", "pass_state:'stopped',stopped_by:code}};", "pass_state:'stopped'}};"],
 ["a success of another unit clears the strike", "const clears=sameUnit(strike,unit);", "const clears=strike.strike_count>0;"],
 ["a success of the unit keeps the strike", "const clears=sameUnit(strike,unit);", "const clears=false;"],
 ["a plan change keeps the strike", "return {action:'replay',run:{...run,...NO_STRIKE,cursor_kind:null", "return {action:'replay',run:{...run,cursor_kind:null"],
 ["a plan change keeps the cursor", "...NO_STRIKE,cursor_kind:null,cursor_id:null,pass_no:run.pass_no+1,pass_state:'passing',stopped_by:null}};\n }", "...NO_STRIKE,pass_no:run.pass_no+1,pass_state:'passing',stopped_by:null}};\n }"],
 ["a plan change keeps pass_no", "pass_no:run.pass_no+1,pass_state:'passing',stopped_by:null}};\n }", "pass_no:run.pass_no,pass_state:'passing',stopped_by:null}};\n }"],
 ["a refusal counts as a strike", "const next=done(run,strike,unit);\n   return {...next,action:verdict.action,", "const next=done(run,strike,unit);\n   return {...next,run:{...next.run,strike_count:1},action:verdict.action,"],
 ["a refusal result has the wrong state", "result:{state:verdict.class,code:verdict.code,attempts:1}", "result:{state:'open',code:verdict.code,attempts:1}"],
 ["the cursor may move backwards", "if(run.cursor_kind!==null&&run.cursor_kind!==undefined&&compareKeys({kind:run.cursor_kind,id:run.cursor_id},unit)>=0)throw invalid();", ""],
 ["a stored count at the limit is accepted", "if(!Number.isInteger(s.strike_count)||s.strike_count<0||s.strike_count>=STRIKE_LIMIT)throw invalid();", "if(!Number.isInteger(s.strike_count)||s.strike_count<0)throw invalid();"],
 ["a count without an identity is accepted", "if((s.strike_count===0)!==(s.strike_id===null)||", "if("],
 ["the trigger accepts a decrement", "return b.strike_count<a.strike_count?'a decrement of an active strike':'a skip of a strike count';", "return null;"],
 ["the trigger accepts a skip", "if(b.strike_count===a.strike_count+1)return b.strike_count>=STRIKE_LIMIT", "if(b.strike_count>a.strike_count)return b.strike_count>=STRIKE_LIMIT"],
 ["the trigger accepts a new identity above 1", "return b.strike_count===1?null:'a new strike identity must start at 1';", "return null;"],
 ["the trigger accepts a reset by a failure", "return cause==='unit_done'||cause==='third_strike'||cause==='plan_changed'?null:'a reset outside the three allowed causes';", "return null;"],
 ["the trigger accepts a systemic change", "if(cause==='systemic')return same?null:'a systemic stop touched a strike column';", "if(cause==='systemic')return null;"],
 // plan identity and cursor order
 ["the fingerprint ignores the unit digests", "const list=units.map(unit=>{if(!DIGEST.test(unit.unitDigest||''))throw invalid();return {kind:unit.kind,id:unit.id,unitDigest:unit.unitDigest};});", "const list=units.map(unit=>({kind:unit.kind,id:unit.id}));"],
 ["the fingerprint ignores the event", "return digestOf({planVersion,origin,event,units:list});", "return digestOf({planVersion,origin,units:list});"],
 ["the fingerprint ignores the origin", "return digestOf({planVersion,origin,event,units:list});", "return digestOf({planVersion,event,units:list});"],
 ["the fingerprint ignores the plan version", "return digestOf({planVersion,origin,event,units:list});", "return digestOf({origin,event,units:list});"],
 ["the fingerprint ignores the kind", "return {kind:unit.kind,id:unit.id,unitDigest:unit.unitDigest};});", "return {id:unit.id,unitDigest:unit.unitDigest};});"],
 ["an unordered plan is accepted", "if(i>0&&compareKeys(units[i-1],units[i])>=0)throw invalid();", ""],
 ["a duplicate unit is accepted", "if(i>0&&compareKeys(units[i-1],units[i])>=0)throw invalid();", "if(i>0&&compareKeys(units[i-1],units[i])>0)throw invalid();"],
 ["the kind rank is ignored", "return ra!==rb?(ra<rb?-1:1):a.id<b.id?-1:a.id>b.id?1:0;", "return a.id<b.id?-1:a.id>b.id?1:0;"],
 ["person states come before Film facts", "export const KIND_RANK=Object.freeze({film_facts:1,person_state:2,film_credits:3});", "export const KIND_RANK=Object.freeze({film_facts:2,person_state:1,film_credits:3});"],
 ["the resume revisits the cursor unit", "while(index<units.length&&compareKeys(units[index],cursor)<=0)index++;", "while(index<units.length&&compareKeys(units[index],cursor)<0)index++;"],
 ["the resume skips the next unit", "while(index<units.length&&compareKeys(units[index],cursor)<=0)index++;", "while(index<units.length&&compareKeys(units[index],cursor)<=0)index++;index++;"],
 ["a changed plan resumes", "if(stored.fingerprint===fingerprint)return {action:'resume'", "if(true)return {action:'resume'"],
 ["an equal plan replays", "if(stored.fingerprint===fingerprint)return {action:'resume'", "if(false)return {action:'resume'"],
 ["a replay keeps pass_no", "return {action:'replay',pass_no:stored.pass_no+1,", "return {action:'replay',pass_no:stored.pass_no,"],
 ["a replay keeps the cursor", "startIndex:0,cursor_kind:null,cursor_id:null,strike:{...NO_STRIKE}", "startIndex:resumeIndex(units,{kind:stored.cursor_kind,id:stored.cursor_id}),cursor_kind:stored.cursor_kind,cursor_id:stored.cursor_id,strike:{...NO_STRIKE}"],
 ["the dictionary unit digest binds the stored state", "return digestOf({operation:'dictionary_unit',id:unit.id,entry:unit.entry});", "return digestOf({operation:'dictionary_unit',id:unit.id});"],
 ["the dictionary unit digest binds nothing of the Film", "return digestOf({operation:'dictionary_unit',id:unit.id,entry:unit.entry});", "return digestOf({operation:'dictionary_unit',entry:unit.entry});"],
 ["the refused digest ignores the list", "return digestOf({operation:'refused_unit',kind,id,source:source===undefined?null:source});", "return digestOf({operation:'refused_unit',kind,id});"],
 // result rows and retry
 ["a terminal state can reopen", "export const canTransition=(from,to)=>LIVE_STATES.includes(from)&&RESULT_STATES.includes(to);", "export const canTransition=(from,to)=>RESULT_STATES.includes(from)&&RESULT_STATES.includes(to);"],
 ["a live row cannot move", "export const canTransition=(from,to)=>LIVE_STATES.includes(from)&&RESULT_STATES.includes(to);", "export const canTransition=(from,to)=>LIVE_STATES.includes(from)&&TERMINAL_STATES.includes(to);"],
 ["a permanent row carries a schedule", "if(row.state==='refused_permanent'&&(has(row.next_attempt_at)||has(row.prereq_stamp)))throw invalid();", ""],
 ["a recoverable row needs no stamp", "if(row.state==='refused_recoverable'&&(row.retry_owner!=='unit'||!has(row.next_attempt_at)||!has(row.prereq_stamp)))throw invalid();", ""],
 ["a receipt row carries a schedule", "if(row.retry_owner!=='unit'&&has(row.next_attempt_at))throw invalid();", ""],
 ["a receipt row has no request id", "if((row.retry_owner==='receipt')!==has(row.request_id))throw invalid();", ""],
 ["an open unit row has no schedule", "if(row.state==='open'&&row.retry_owner!=='receipt'&&!has(row.next_attempt_at))throw invalid();", ""],
 ["a terminal row needs no settled time", "if(TERMINAL_STATES.includes(row.state)!==has(row.settled_at))throw invalid();", ""],
 ["the attempts have no bound", "if(!Number.isInteger(row.attempts)||row.attempts<1||row.attempts>16)throw invalid();", ""],
 ["a row keeps a stamp it must not have", "prereq_stamp:state==='refused_recoverable'?prereqStamp:null,", "prereq_stamp:prereqStamp,"],
 ["the schedule ignores the policy", "const schedule=retryOwner==='unit'&&(state==='open'||state==='refused_recoverable')?nextAttemptAt(now,attempts):null;", "const schedule=retryOwner==='unit'&&(state==='open'||state==='refused_recoverable')?nextAttemptAt(now,1):null;"],
 ["a changed digest is not superseded", "if(live.unit_digest!==row.unit_digest)return {supersede:", "if(false)return {supersede:"],
 ["an equal digest is superseded", "if(live.unit_digest!==row.unit_digest)return {supersede:", "if(true)return {supersede:"],
 ["a supersede has the wrong reason", "{key:keyOfRow(live),...supersede(live,'source_changed',row.created_at)}", "{key:keyOfRow(live),...supersede(live,'left_plan',row.created_at)}"],
 ["the pass_no is not part of the row key", "pass_no:row.pass_no,kind:row.kind,unit_id:row.unit_id});", "kind:row.kind,unit_id:row.unit_id});"],
 ["a terminal row can be written over", "if(!LIVE_STATES.includes(live.state)||live.kind!==row.kind", "if(live.kind!==row.kind"],
 ["a same-digest failure adds no attempt", "const bump=row.state==='open'?live.attempts+1:live.attempts;", "const bump=live.attempts;"],
 ["a refusal adds an attempt", "const bump=row.state==='open'?live.attempts+1:live.attempts;", "const bump=live.attempts+1;"],
 ["a terminal row is retried", "if(TERMINAL_STATES.includes(row.state))return {action:'none',reason:'terminal'};", ""],
 ["a unit that left the plan stays live", "if(ctx.currentUnitDigest===null)return supersede(row,'left_plan',at);", ""],
 ["a changed digest stays live", "if(ctx.currentUnitDigest!==row.unit_digest)return supersede(row,'source_changed',at);", ""],
 ["a permanent refusal is retried", "if(row.state==='refused_permanent')return {action:'none',reason:'permanent_never_retried'};", ""],
 ["a receipt row is retried by the unit", "if(row.retry_owner==='receipt')return {action:'none',reason:'receipt_owned'};", ""],
 ["an unchanged stamp is applied", "if(ctx.currentStamp===row.prereq_stamp)return {action:'defer'", "if(false)return {action:'defer'"],
 ["a changed stamp only defers", "if(ctx.currentStamp===row.prereq_stamp)return {action:'defer'", "if(true)return {action:'defer'"],
 ["a deferral uses the first backoff step", "next_attempt_at:iso(ctx.nowMs+lastBackoffMs()),updated_at:at}};", "next_attempt_at:iso(ctx.nowMs+backoffMs(1)),updated_at:at}};"],
 ["a deferral consumes an attempt", "next_attempt_at:iso(ctx.nowMs+lastBackoffMs()),updated_at:at}};", "next_attempt_at:iso(ctx.nowMs+lastBackoffMs()),updated_at:at,attempts:row.attempts+1}};"],
 ["a recoverable refusal is abandoned", "if(row.state==='refused_recoverable'){\n  // Never abandoned", "if(row.state==='refused_recoverable'&&row.attempts>=RETRY_POLICY.maxAttempts)return {action:'abandon',patch:{state:'abandoned'}};\n if(row.state==='refused_recoverable'){\n  // Never abandoned"],
 ["an execution failure is never abandoned by attempts", "if(row.attempts>=RETRY_POLICY.maxAttempts||ctx.nowMs", "if(ctx.nowMs"],
 ["an execution failure is never abandoned by age", "||ctx.nowMs-timeOf(row.created_at)>=RETRY_POLICY.abandonAfterMs)return", ")return"],
 ["a retry ignores the schedule", "if(ctx.trigger==='due'&&!due)return {action:'none',reason:'not_due'};\n return {action:'retry_apply'};", "return {action:'retry_apply'};"],
 ["a recoverable revalidation ignores the schedule", "if(ctx.trigger==='due'&&!due)return {action:'none',reason:'not_due'};\n  if(!DIGEST", "if(!DIGEST"],
 ["a settle needs no proof", "if(outcome.proof!=='applied_receipt'&&outcome.proof!=='verified_noop')throw invalid();", ""],
 ["an unproven write settles", "if(outcome.kind==='not_proven')return {action:'none',reason:'no_write_proof'};", "if(outcome.kind==='not_proven')return {action:'settle',patch:{state:'settled',settled_by:'applied'}};"],
 ["a recoverable settle has the wrong reason", "settled_by:row.state==='refused_recoverable'?'prerequisite_resolved':'applied'", "settled_by:'applied'"],
 ["a systemic failure updates the row", "if(verdict.action==='stop')return {action:'stop',code:verdict.code};\n if(verdict.action==='keep')", "if(verdict.action==='keep')"],
 ["a permanent reclassification keeps the stamp", "patch:{state:'refused_permanent',code:verdict.code,prereq_stamp:null,next_attempt_at:null,updated_at:at}}", "patch:{state:'refused_permanent',code:verdict.code,prereq_stamp:row.prereq_stamp,next_attempt_at:null,updated_at:at}}"],
 ["a new stamp is not taken", "patch:{state:'refused_recoverable',code:verdict.code,prereq_stamp:outcome.stamp,", "patch:{state:'refused_recoverable',code:verdict.code,prereq_stamp:row.prereq_stamp,"],
 ["an execution failure adds no attempt", "const attempts=Math.min(row.attempts+1,16);", "const attempts=row.attempts;"],
 // stamp
 ["the stamp accepts content fields", "if(Object.keys(snapshot).some(key=>!allowed.has(key))||[...allowed].some(key=>!Object.hasOwn(snapshot,key)))throw invalid();", ""],
 ["the stamp accepts content in an item", "Object.keys(value).sort().join(',')!=='id,revision'||", ""],
 ["the stamp accepts text as an identifier", "typeof value.id!=='string'||!IDENTIFIER.test(value.id)||", "typeof value.id!=='string'||"],
 ["a set stamp depends on the order", "list.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);", ""],
 ["a set accepts a duplicate", "if(list.some((entry,i)=>i>0&&list[i-1].id===entry.id))throw invalid();", ""],
 ["the stamp ignores the revisions", "return {id:value.id,revision:value.revision};", "return {id:value.id,revision:null};"],
 ["the Film may be absent from its stamp", "if(key==='film'&&fields[key]===null)throw invalid();", ""],
 ["no stamp spec for the redirect", " film_person_redirect:{one:['film','redirect'],many:[]},", ""],
 ["the reference stamp ignores the Persons", "film_person_reference:{one:['film'],many:['persons']},", "film_person_reference:{one:['film'],many:[]},"],
 ["the owner-review stamp ignores the materialised rows", "owner_review_inconsistent:{one:['film','entry'],many:['materialised']},", "owner_review_inconsistent:{one:['film','entry'],many:[]},"],
 // owner review
 ["a missing owner entry is a refusal", "if(input.entry==='absent')return {decision:'proceed',case:'no_entry'};", "if(input.entry==='absent')return {decision:'refuse',class:CLASS.RECOVERABLE,code:'owner_review_inconsistent'};"],
 ["a failed check proceeds", "if(!plain(input)||input.read!=='ok')return", "if(!plain(input))return"],
 ["an unmaterialised entry proceeds", "if(input.entry==='present'&&input.materialised==='yes')return {decision:'proceed',case:'materialised'};", "if(input.entry==='present')return {decision:'proceed',case:'materialised'};"],
 ["an unreadable entry proceeds", "||input.entry==='unreadable')return {decision:'refuse'", ")return {decision:'refuse'"],
 ["an inconsistent entry stops the pass", "return {decision:'refuse',class:CLASS.RECOVERABLE,code:'owner_review_inconsistent'};", "return {decision:'stop',class:CLASS.SYSTEMIC,code:'owner_review_check_failed'};"],
 // freshness
 ["a lagging pass is current", "if(applied!==publishedGeneration)return 'lagging';", ""],
 ["a backwards generation is current", "if(applied!==publishedGeneration)return 'lagging';", "if(applied>publishedGeneration)return 'lagging';"],
 ["a live film_facts result is current", "return liveFilmFactsResults>0?'partial':'current';", "return 'current';"],
 ["every result is partial", "return liveFilmFactsResults>0?'partial':'current';", "return 'partial';"],
 ["a missing run is unknown", "if(run===null)return 'lagging';", "if(run===null)return 'unknown';"],
 ["a missing run is current", "if(run===null)return 'lagging';", "if(run===null)return 'current';"],
 ["an unreadable store is lagging", "if(typeof publishedGeneration!=='string'||!publishedGeneration||run===undefined)return 'unknown';", "if(typeof publishedGeneration!=='string'||!publishedGeneration)return 'unknown';\n if(run===undefined)return 'lagging';"],
 ["an unreadable count is zero", "if(!Number.isInteger(liveFilmFactsResults)||liveFilmFactsResults<0)return 'unknown';", ""],
 ["an inconsistent run row is trusted", "if(applied!==null&&applied!==undefined&&(run.pass_state!=='passed'||applied!==run.source_generation))return 'unknown';", ""],
 // cursor and minting
 ["the cursor passes a failed unit", "if(!unit||unit.kind!==item.kind||unit.id!==item.id||!DURABLE_OUTCOMES.includes(item.outcome))break;", "if(!unit||unit.kind!==item.kind||unit.id!==item.id)break;"],
 ["the cursor stops at nothing", "if(!unit||unit.kind!==item.kind||unit.id!==item.id||!DURABLE_OUTCOMES.includes(item.outcome))break;", "if(!unit)break;"],
 ["a strike is a durable outcome", "export const DURABLE_OUTCOMES=Object.freeze(['applied','noop','kept','absent','result_written']);", "export const DURABLE_OUTCOMES=Object.freeze(['applied','noop','kept','absent','result_written','strike']);"],
 ["an equal digest mints", "if(latest.snapshot_digest===snapshotDigest)return {action:'reuse'", "if(false)return {action:'reuse'"],
 ["a different digest reuses", "if(latest.snapshot_digest===snapshotDigest)return {action:'reuse'", "if(true)return {action:'reuse'"],
 ["the minted seq repeats", "const seq=latest.seq+1;", "const seq=latest.seq;"],
 ["the minted seq skips", "const seq=latest.seq+1;", "const seq=latest.seq+2;"],
 ["the first version is not d1", "return {action:'mint',seq:1,prev_seq:0,run_key:'d1',", "return {action:'mint',seq:2,prev_seq:1,run_key:'d2',"],
 ["the minted prev_seq is wrong", "return {action:'mint',seq,prev_seq:latest.seq,run_key:'d'+seq,", "return {action:'mint',seq,prev_seq:0,run_key:'d'+seq,"],
 ["the previous run is not superseded", "supersedes:latest.run_key};", "supersedes:null};"],
 ["a label that is not d<seq> is accepted", "latest.run_key!=='d'+latest.seq||", ""],
 ["a minted guard lets a same-digest insert through", "guard:{prev_seq:latest.seq,previous_exists:true,previous_digest_differs:true}", "guard:{prev_seq:latest.seq,previous_exists:true}"],
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'producer-run-mutants-'));
try{
 const original=fs.readFileSync(path.join('src',FILE),'utf8');
 for(const [name,from] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+FILE);
 const run=env=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-producer-run.mjs'],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],timeout:30000});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.mkdirSync(copy);
  for(const entry of fs.readdirSync('src'))if(entry!==FILE)fs.symlinkSync(path.resolve('src',entry),path.join(copy,entry));
  fs.writeFileSync(path.join(copy,FILE),original.replace(from,()=>to));
  return {name,env:{RUN_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.RUN_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-producer-run-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
