// AIR-489: mutation check of the Diary identity module. Each mutant weakens one identity, fence or budget rule; the behaviour test must fail on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const SOURCE = fs.readFileSync('src/letterboxd-diary-identity.js', 'utf8');
const MUTANTS = [
  ['slug is not compared', "if(evidence.path!=='/film/'+slug+'/')return {state:'unresolved',reason:'slug_mismatch'};", ''],
  ['a missing slug is requested', "if(!item.slug){set[lid]=entry(item,'slug_missing',attempts+1,now+delayMs('review',attempts+1));counts.pending++;continue;}", ''],
  ['shortlink mismatch passes', "if(evidence.shortlinkPresent&&evidence.shortCode!==lid)return {state:'unresolved',reason:'shortlink_mismatch'};", ''],
  ['canonical mismatch passes', "if(evidence.canonicalPath&&evidence.canonicalPath!==evidence.path)return {state:'unresolved',reason:'canonical_mismatch'};", ''],
  ['two TMDB ids pass', "if(evidence.tmdbIds.length>1)return {state:'unresolved',reason:'tmdb_multiple'};", ''],
  ['a non-movie type passes', "if(!(evidence.tmdbTypes.length===1&&evidence.tmdbTypes[0]==='movie'))return {state:'unresolved',reason:evidence.tmdbTypes.length?'tmdb_not_movie':'tmdb_type_missing'};", ''],
  ['TMDB detail agreement is skipped', "if(!agree.ok)return {state:'unresolved',reason:agree.reason};", ''],
  ['backoff is ignored', "Date.parse(prior.nextAttemptAt)>now", 'false'],
  ['attempt cap is ignored', "attempts>=MAX_ATTEMPTS||", ''],
  ['step cap is ignored', "fetched>=STEP_LIMIT||", ''],
  ['lease budget is ignored', "||remaining()<STEP_BUDGET_MS", ''],
  ['a transport stop does not stop the step', "if(outcome.stop)stopped=true;", ''],
  ['an id without a record is bridged', "if(!own.factKey){counts.skipped++;continue;}", ''],
  ['a conflicting bridge is overridden', "if(bridge&&(bridge.state==='conflict'||bridge.state==='retired')){", "if(false){"],
  ['an existing receipt for another code is accepted', "if(admitted==='conflict'||admitted==='other_code')", "if(false)"],
  ['an admission failure is not a pending', "}catch(error){outcome={state:'pending',reason:error?.code==='admission_identity_held'||error?.reason?'admission_held':error?.code||'admission_failed'};}", "}catch(error){throw error;}"],
  ['a skipped writer counts as an admission', "if(!out||out.state!=='complete')return false;", "if(!out)return false;"],
  ['a failed count is ignored', "if(Number(out.failed||0)||Number(out.unknown||0)||Number(out.preflightFailed||0)||Number(out.refused||0)||Number(out.deferred||0))return false;", ''],
  ['any unit counts as an admission', "unit.kind==='film_admission'&&['applied','already','noop'].includes(unit.state)", 'true'],
  ['the network budget is not enforced', "if(!(left>1000))throw Object.assign(new Error('step budget exhausted'),{name:'TimeoutError'});", ''],
  ['the write reserve is not checked after the checks', "if(remaining()<WRITE_RESERVE_MS)return {state:'pending',reason:'budget',stop:true};", ''],
  ['an id that left the page is never retried', "!onPage.has(lid)&&entry&&", 'false&&entry&&'],
  ['a not-open authority drops the id', "if(!open){defer(item,prior);continue;}", "if(!open){counts.skipped++;continue;}"],
  ['a held bridge read drops the id', "includes(error?.code)){defer(item,prior);continue;}bridge=null;}", "includes(error?.code)){counts.skipped++;continue;}bridge=null;}"],
  ['a link throw on a consumed bridge drops the id', "    }catch{defer(item,prior);continue;}\n   }\n   if(bridge&&", "    }catch{counts.skipped++;continue;}\n   }\n   if(bridge&&"],
  ['a newly seen slug is not saved on the pending entry', "if(prior&&item.onPage&&item.slug&&prior.slug!==item.slug)set[lid]={...prior,slug:item.slug};", ''],
  ['a linked id with a pending entry is cleared without a repair', "if(!prior){clear.push(lid);continue;}", "{clear.push(lid);continue;}"],
  ['a failed repair clears the entry', "else{counts.skipped++;}}catch{counts.skipped++;}", "else{counts.skipped++;}}catch{clear.push(lid);}"],
  ['a step-cap deferral resets the entry', "remaining()<STEP_BUDGET_MS){defer(item,prior);continue;}", "remaining()<STEP_BUDGET_MS){defer(item,null);continue;}"],
  ['a deferred id is dropped', "if(item.onPage&&!prior&&item.slug)set[item.lid]={reason:'deferred',slug:item.slug||null,attempts:0,lastAttemptAt:null,nextAttemptAt:iso(now)};", ''],
  ['the slug is not kept for the retry', "slug:item.slug||null,attempts,lastAttemptAt:iso(now)", "slug:null,attempts,lastAttemptAt:iso(now)"],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air489-'));
let killed = 0;
for (const [name, from, to] of MUTANTS) {
  assert.ok(SOURCE.includes(from), 'mutation anchor missing: ' + name);
  const file = path.join(dir, 'mutant.js');
  fs.writeFileSync(file, SOURCE.replace(from, to));
  const run = spawnSync(process.execPath, ['tests/letterboxd-diary-identity.mjs'], {env: {...process.env, DIARY_IDENTITY_SRC: file}, encoding: 'utf8'});
  assert.notEqual(run.status, 0, 'mutants that no test kills: ' + name);
  killed++;
}
fs.rmSync(dir, {recursive: true, force: true});
console.log('letterboxd-diary-identity-mutation: ok (' + killed + ' mutants killed)');
