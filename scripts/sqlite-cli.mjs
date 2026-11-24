// The sqlite3 command-line shell is the SQLite engine of the test suite (tests/sqlite-session.mjs, tests/d1-standin.mjs and the files that spawn `sqlite3`).
//
// Two shells on macOS made the suite wrong without a red assertion of their own (24 Nov 2026):
//  - sqlite3 3.54 (macOS /usr/bin/sqlite3 3.54.0 and Homebrew 3.54.1) reads no standard input when `-cmd` and `-bail` are both given and exits 0, so every
//    script "succeeded" with empty output and nothing ran. tests/sqlite-session.mjs no longer passes `-cmd` and checks a start and an end marker on every call.
//  - macOS /usr/bin/sqlite3 3.54.0 does not stop at the statement that fails under `-bail`: the rest of the same input line still runs, so `BEGIN;...;COMMIT;`
//    on one line commits what came before and after the failed statement. The tests rely on that stop (a refused write leaves nothing behind).
// `sqliteCliProblem(command)` runs one small script the way the harness runs every script and returns what is wrong with that shell, or null.
// `resolveSqliteCli()` is for scripts/run-tests.mjs: the `sqlite3` of PATH when it passes, otherwise the first Homebrew sqlite3 that does.
import {spawnSync} from 'node:child_process';
import {accessSync,constants,statSync} from 'node:fs';
import path from 'node:path';

const START='__SQLITE_CLI_PROBE_START__',END='__SQLITE_CLI_PROBE_END__';
const RAN='executed',LEAKED='continued after the failing statement';
// Line 3 fails on its second statement; a shell that honours -bail prints RAN and stops, before END and before the third statement of that line.
const PROBE=`.print ${START}\nPRAGMA synchronous=OFF;\nCREATE TABLE probe(a INTEGER PRIMARY KEY);INSERT INTO probe VALUES (1);\nSELECT '${RAN}';INSERT INTO probe VALUES (1);SELECT '${LEAKED}';\n.print ${END}\n`;
// Homebrew installs sqlite keg-only (not linked into PATH): Apple Silicon, then Intel.
export const HOMEBREW_SQLITE=['/opt/homebrew/opt/sqlite/bin/sqlite3','/usr/local/opt/sqlite/bin/sqlite3'];
export const SQLITE_FIX='Put a sqlite3 that passes this check first in PATH (on macOS: brew install sqlite, then PATH="$(brew --prefix sqlite)/bin:$PATH"); npm test picks a Homebrew sqlite3 on its own.';

const version=command=>{const result=spawnSync(command,['-version'],{encoding:'utf8',timeout:10000});return String(result.stdout||'').split(' ')[0]||'unknown version';};
export function sqliteCliProblem(command='sqlite3'){
 const result=spawnSync(command,['-bail',':memory:'],{input:PROBE,encoding:'utf8',timeout:30000});
 const name=()=>`sqlite3 shell ${command} (${version(command)})`;
 if(result.error)return `${name()} could not be run: ${result.error.message}`;
 const stdout=String(result.stdout||''),stderr=String(result.stderr||'').trim();
 if(!stdout.startsWith(START+'\n')||!stdout.includes('\n'+RAN+'\n'))return `${name()} did not run its standard input (exit ${result.status}, stdout ${JSON.stringify(stdout.slice(0,200))}, stderr ${JSON.stringify(stderr.slice(0,200))}). ${SQLITE_FIX}`;
 if(stdout.includes(LEAKED)||stdout.includes(END))return `${name()} kept running statements after one failed under -bail (stdout ${JSON.stringify(stdout.slice(0,200))}), so a refused write could leave rows behind. ${SQLITE_FIX}`;
 if(result.status===0||!/UNIQUE constraint failed/.test(stderr))return `${name()} did not report the failing statement (exit ${result.status}, stderr ${JSON.stringify(stderr.slice(0,200))}). ${SQLITE_FIX}`;
 return null;
}

const executable=file=>{try{accessSync(file,constants.X_OK);return statSync(file).isFile();}catch{return false;}};
export function onPath(name='sqlite3',pathValue=process.env.PATH||''){
 for(const directory of pathValue.split(path.delimiter)){if(!directory)continue;const file=path.join(directory,name);if(executable(file))return file;}
 return null;
}
// {command, directory, fallback, problems}: command is the first candidate that passes (directory is where it lives); fallback is true when it is not the
// first candidate (the sqlite3 of PATH), and problems names every candidate that failed. Without a passing candidate, command is null.
export function resolveSqliteCli({candidates=[onPath('sqlite3'),...HOMEBREW_SQLITE.filter(executable)]}={}){
 const problems=[],seen=new Set();
 for(const [index,candidate] of candidates.entries()){
  if(!candidate||seen.has(candidate))continue;
  seen.add(candidate);
  const problem=sqliteCliProblem(candidate);
  if(!problem)return {command:candidate,directory:path.dirname(candidate),fallback:index>0,problems};
  problems.push(problem);
 }
 if(!problems.length)problems.push(`no sqlite3 found on PATH or in ${HOMEBREW_SQLITE.join(', ')}. ${SQLITE_FIX}`);
 return {command:null,directory:null,fallback:false,problems};
}
