// AIR-489: mutation check of the Diary identity module. Each mutant weakens one identity, fence or budget rule; the behaviour test must fail on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const SOURCE = fs.readFileSync('src/letterboxd-diary-identity.js', 'utf8');
const MUTANTS = [
  ['slug is not compared', "if(evidence.path!=='/film/'+slug+'/')return {state:'unresolved',reason:'slug_mismatch'};", ''],
  ['a missing slug passes', "if(typeof slug!=='string'||!SLUG.test(slug))return {state:'unresolved',reason:'slug_missing'};", ''],
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
  ['the marker gate is ignored', "if(!open){counts.skipped++;continue;}", ''],
  ['a conflicting bridge is overridden', "if(bridge&&(bridge.state==='conflict'||bridge.state==='retired')){", "if(false){"],
  ['an existing receipt for another code is accepted', "if(admitted==='conflict'||admitted==='other_code')", "if(false)"],
  ['an admission failure is not a pending', "outcome={state:'pending',reason:error?.code==='admission_identity_held'||error?.reason?'admission_held':error?.code||'admission_failed'};", "throw error;"],
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
