// AIR-489: mutation check of the Diary identity module. Each mutant weakens one identity, fence or budget rule; the behaviour test must fail on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const SOURCE = fs.readFileSync('src/letterboxd-diary-identity.js', 'utf8');
const MUTANTS = [
  ['slug is not compared', "if(evidence.path!=='/film/'+slug+'/')return {state:'unresolved',reason:'slug_mismatch'};", ''],
  ['a missing slug is requested', "if(!item.slug){record(item,'slug_missing');continue;}", ''],
  ['shortlink mismatch passes', "if(evidence.shortlinkPresent&&evidence.shortCode!==lid)return {state:'unresolved',reason:'shortlink_mismatch'};", ''],
  ['canonical mismatch passes', "if(evidence.canonicalPath&&evidence.canonicalPath!==evidence.path)return {state:'unresolved',reason:'canonical_mismatch'};", ''],
  ['two TMDB ids pass', "if(evidence.tmdbIds.length>1)return {state:'unresolved',reason:'tmdb_multiple'};", ''],
  ['a non-movie type passes', "if(!(evidence.tmdbTypes.length===1&&evidence.tmdbTypes[0]==='movie'))return {state:'unresolved',reason:evidence.tmdbTypes.length?'tmdb_not_movie':'tmdb_type_missing'};", ''],
  ['TMDB detail agreement is skipped', "if(!agree.ok)return {state:'unresolved',reason:agree.reason};", ''],
  ['backoff is ignored', "Date.parse(prior.nextAttemptAt)>now", 'false'],
  ['attempt cap is ignored', "if(prior&&(eff>=MAX_ATTEMPTS||Date.parse(prior.nextAttemptAt)>now)){", "if(prior&&(Date.parse(prior.nextAttemptAt)>now)){"],
  ['step cap is ignored', "fetched>=STEP_LIMIT||", ''],
  ['lease budget is ignored', "||remaining()<STEP_BUDGET_MS", ''],
  ['a transport stop does not stop the step', "if(outcome.stop)stopped=true;", ''],
  ['an id without a record is bridged', "if(!own.factKey){counts.skipped++;", "if(false){counts.skipped++;"],
  ['a conflicting bridge is overridden', "if(bridge&&(bridge.state==='conflict'||bridge.state==='retired')){", "if(false){"],
  ['an existing receipt for another code is accepted', "if(admitted==='conflict'||admitted==='other_code')", "if(false)"],
  ['an admission failure is not a pending', "}catch(error){outcome={state:'pending',reason:error?.code==='admission_identity_held'", "}catch(error){throw error;outcome={state:'pending',reason:error?.code==='admission_identity_held'"],
  ['a skipped writer counts as an admission', "if(!out||out.state!=='complete')return false;", "if(!out)return false;"],
  ['a failed count is ignored', "if(Number(out.failed||0)||Number(out.unknown||0)||Number(out.preflightFailed||0)||Number(out.refused||0)||Number(out.deferred||0))return false;", ''],
  ['any unit counts as an admission', "unit.kind==='film_admission'&&['applied','already','noop'].includes(unit.state)", 'true'],
  ['the network budget is not enforced', "if(!(left>1000))throw Object.assign(new Error('step budget exhausted'),{name:'TimeoutError'});", ''],
  ['the write reserve is not checked after the checks', "if(remaining()<WRITE_RESERVE_MS)throw Object.assign(new Error('budget'),{code:'budget'});", ''],
  ['an id that left the page is never retried', "!onPage.has(lid)&&entry&&", 'false&&entry&&'],
  ['a not-open authority drops the id', "if(!open){defer(item,prior);continue;}", "if(!open){counts.skipped++;continue;}"],
  ['a held bridge read drops the id', "includes(error?.code)){defer(item,prior);continue;}bridge=null;}", "includes(error?.code)){counts.skipped++;continue;}bridge=null;}"],
  ['a link throw on a consumed bridge drops the id', "    }catch{defer(item,prior);continue;}\n   }\n   if(bridge&&", "    }catch{counts.skipped++;continue;}\n   }\n   if(bridge&&"],
  ['a newly seen slug is not saved on the pending entry', "if(prior&&item.onPage&&item.slug&&prior.slug!==item.slug)set[lid]={...prior,slug:item.slug};", ''],
  ['a linked id with a pending entry is cleared without a repair', "if(!prior){clear.push(lid);continue;}", "{clear.push(lid);continue;}"],
  ['a failed repair clears the entry', "else{counts.skipped++;}}catch{counts.skipped++;}", "else{counts.skipped++;}}catch{clear.push(lid);}"],
  ['a step-cap deferral resets the entry', "remaining()<STEP_BUDGET_MS){defer(item,prior);continue;}", "remaining()<STEP_BUDGET_MS){defer(item,null);continue;}"],
  ['the link intent is not required before the effects', "if(!(await intend(item,outcome.verdict.tmdb)))throw Object.assign(new Error('intent_unwritten'),{code:'intent_unwritten'});", ''],
  ['a repair is held back by the source cap', "(repair(entry)||typeof entry.slug", "(false||typeof entry.slug"],
  ['a confirmed link_failed is not completed locally', "if(prior&&prior.reason==='link_failed'&&TMDB.test(String(prior.tmdb||''))){", "if(false){"],
  ['link_failed loses its verified movie id', "...(linked.state==='conflict'?{}:{tmdb:outcome.verdict.tmdb})", ''],
  ['an interrupted intent stays a repair forever', "if(eff>=MAX_ATTEMPTS&&LINK_REASONS.has(prior.reason))set[lid]={...prior,...(set[lid]||{}),reason:'link_interrupted',class:'definite'};", ''],
  ['a deferred id is dropped', "if(!prior&&(item.slug||item.fromBacklog))set[item.lid]={reason:'deferred'", "if(false)set[item.lid]={reason:'deferred'"],
  ['the slug is not kept for the retry', "slug:item.slug||cur?.slug||null,attempts,streak", "slug:null,attempts,streak"],
  // AIR-599 / ADR 0207 decision 4b: the one retry contract.
  ['a transport stop is charged as an attempt', "else if(cls==='transport'){streak=streakBefore+1;", "else if(false){streak=streakBefore+1;"],
  ['a not-now outcome is charged as an attempt', "if(intent||cls==='not_now'){", "if(intent){"],
  ['a 404 is not gone', "if(result.status===404||result.status===410)return 'not_found';", ''],
  ['a 5xx is not transport', "if(result.status>=500)return 'upstream_5xx';", ''],
  ['a refused reservation still checks the id', "if(taken==='ok')return true;", "if(taken==='ok'||taken==='refused')return true;"],
  ['the queue position is ignored', "x.first-y.first||(x.pos<y.pos?-1:x.pos>y.pos?1:0)||x.index-y.index", "x.first-y.first||x.index-y.index"],
  // Review of PR #1009: writes bound to the entry as read; the budget survives the backlog; the stored slug serves a caller without one.
  ['the final write ignores a moved entry', "expect:expectOf([...Object.keys(inSet),...inClear,...inRemove,...Object.keys(inAdd)]),", "expect:null,"],
  ['the link intent ignores a moved entry', "if(out?.refused?.includes(item.lid)||out?.conflicts?.includes(item.lid))return false;", "if(out?.refused?.includes(item.lid))return false;"],
  ['the claim write ignores a moved entry', "expect:Object.fromEntries([...Object.keys(claimSet),...claimClear].map(lid=>[lid,afterStep(lid)]))", "expect:null"],
  ['a lost race is charged as a check', "if(conflicted.includes(lid)){outcomes.set(lid,{checked:checked.has(lid),class:'not_now',reason:'entry_changed',retryAt:null,attempts:null,streak:null,terminal:false});continue;}", ""],
  ['the backlog forgets the row budget', "backlogAdd[item.lid]={slug:item.slug||null,queuedAt:item.queuedAt||iso(now),attempts:item.seed||0};", "backlogAdd[item.lid]={slug:item.slug||null,queuedAt:item.queuedAt||iso(now),attempts:0};"],
  ['a backlog intake starts from zero', "seed:Math.min(MAX_ATTEMPTS,Math.max(0,Number(item.attempts)||0))}));", "seed:0}));"],
  ['the row budget is not applied to the entry', "const before=Math.max(cur?Number(cur.attempts)||0:0,item.seed||0),streakBefore", "const before=cur?Number(cur.attempts)||0:item.seed||0,streakBefore"],
  // Second review of PR #1009: exclusive check ownership, the effective cap, the settle token.
  ['a reservation is not honoured', "if(reservedActive(prior)&&!mine.has(lid)){", "if(false){"],
  ['no reservation before the source', "const taken=await reserve(item,prior);", "const taken='ok';"],
  ['a reservation never expires', "Date.parse(entry.reservation.until)>now;", "true;"],
  ['the cap ignores the row budget of a missing entry', "if(!prior&&eff>=MAX_ATTEMPTS){", "if(false){"],
  ['the cap ignores the row budget of an entry', "const eff=Math.max(attempts,item.seed||0);", "const eff=attempts;"],
  ['the reservation ignores the backlog record', "expectBacklog:{[lid]:baseB[lid]??null}", "expectBacklog:null"],
  ['the intake is not removed from the backlog by the reservation', "backlogRemove:fromBacklog?[lid]:[]", "backlogRemove:[]"],
  // Third review of PR #1009: the stale seed is guarded by the row token; every effect is under a reservation.
  ['the reservation drops the row-token guard', ",extra:item.guard?[item.guard]:[]});", ",extra:[]});"],
  ['the final write drops the row-token guard', "extra:guardsOf(lids),", ""],
  // Fourth review of PR #1009: the guard covers the backlog write too; one stale id never rolls back another; the reservation bounds every effect.
  ['the final write guards only the entries, not the backlog write', "extra:guardsOf(lids),", "extra:guardsOf(Object.keys(inSet)),"],
  ['a refused batch is not isolated per id', "if(error&&error.code==='write_contention'&&idsOf.length>1){", "if(false){"],
  // Fifth review of PR #1009: the effects commit through their reservation; a local effect never starts late.
  ['the trusted-bridge link commits without its reservation guard', "LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:bridge.tmdb})", "LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:bridge.tmdb})"],
  ['the link completion commits without its reservation guard', "LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:String(prior.tmdb)})", "LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:String(prior.tmdb)})"],
  ['the canonical admission commits without its reservation guard', "applyRatedAdmissionRetention(guarded(lid),", "applyRatedAdmissionRetention(env,"],
  ['the final link commits without its reservation guard', "bridgeDiaryFilm(guarded(lid),{lid,tmdb:outcome.verdict.tmdb})", "bridgeDiaryFilm(env,{lid,tmdb:outcome.verdict.tmdb})"],
  ['a trusted bridge links after the window', "if(late()||!guarded(lid))throw Object.assign(new Error('late'),{code:'late'});\n     const linked=await LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:bridge.tmdb});", "const linked=await LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:bridge.tmdb});"],
  ['the reservation does not bound the effects', "const remaining=()=>Math.min(callerRemaining(),now+RESERVATION_MS-15000-clock());", "const remaining=callerRemaining;"],
  ['a trusted-bridge link is not reserved', "if(!(await take(item,stored.films[lid]||null)))continue;\n    if(!(await intend(item,bridge.tmdb)))", "if(!(await intend(item,bridge.tmdb)))"],
  ['a link repair is not reserved', "if(!(await take(item,prior)))continue;\n    try{", "try{"],
  ['the stored slug is not used', "if(!item.slug&&typeof prior?.slug==='string'&&SLUG.test(prior.slug))item.slug=prior.slug;", ""],
  ['a dismissed entry is checked again', "if(prior&&prior.reason==='owner_dismissed'){settled.set(lid,'owner_dismissed');continue;}", ''],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air489-'));
let killed = 0;
for (const [name, from, to] of MUTANTS) {
  assert.ok(SOURCE.includes(from), 'mutation anchor missing: ' + name);
  const file = path.join(dir, 'mutant.js');
  fs.writeFileSync(file, SOURCE.replace(from, to));
  // The behaviour test first; the D1-backed test only when the first did not kill the mutant.
  let run = spawnSync(process.execPath, ['tests/letterboxd-diary-identity.mjs'], {env: {...process.env, DIARY_IDENTITY_SRC: file}, encoding: 'utf8'});
  if (run.status === 0) run = spawnSync(process.execPath, ['tests/letterboxd-diary-identity-d1.mjs'], {env: {...process.env, DIARY_IDENTITY_SRC: file}, encoding: 'utf8'});
  if (run.status === 0) run = spawnSync(process.execPath, ['tests/letterboxd-owner-race-d1.mjs'], {env: {...process.env, DIARY_IDENTITY_SRC: file}, encoding: 'utf8'});
  assert.notEqual(run.status, 0, 'mutants that no test kills: ' + name);
  killed++;
}
fs.rmSync(dir, {recursive: true, force: true});
console.log('letterboxd-diary-identity-mutation: ok (' + killed + ' mutants killed)');
