// AIR-668: the pass record the pre-push hook reads. A `--suite all` run that passes on an unchanged working tree records that tree; the hook skips the
// suite only for a pushed commit whose tree was recorded, or differs from a recorded tree only outside the paths that need the suite. Everything is
// exercised in throwaway Git repositories, never in this checkout.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EXECUTABLE_PATHS,RECORD_LIMIT,appendRecord,changedPaths,contentTree,coveringRecord,readRecords,recordPath,touchesExecutable,uncoveredByWorkingTree} from '../scripts/test-pass-record.mjs';

const repoRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
// The hook runs this suite with GIT_DIR exported (tests/epg-checkpoint-production.mjs); a git child that inherited it would act on this checkout.
// IPTV_PREPUSH_RERUN and IPTV_TEST_PASS_RECORD from a forced hook run must not reach the hook and runner these cases start.
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&key!=='IPTV_PREPUSH_RERUN'&&key!=='IPTV_TEST_PASS_RECORD'));
Object.assign(env,{GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid',GIT_CONFIG_NOSYSTEM:'1',HOME:os.tmpdir()});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'air668-pass-record-'));
let counter=0;
const git=(cwd,...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(cwd,file,text)=>{fs.mkdirSync(path.dirname(path.join(cwd,file)),{recursive:true});fs.writeFileSync(path.join(cwd,file),text);};
function repo(){
 const cwd=path.join(scratch,'repo-'+(++counter));
 fs.mkdirSync(cwd);
 git(cwd,'init','-q','-b','main');
 write(cwd,'.gitignore','ignored/\nran\n');
 write(cwd,'src/a.js','export const a=1;\n');
 write(cwd,'docs/a.md','# a\n');
 git(cwd,'add','-A');
 git(cwd,'commit','-qm','one');
 return cwd;
}
const at={cwd:undefined,env};

try{
 // 1. The content tree is the tree `git add -A` would commit: HEAD's tree when clean, untracked files included, ignored files left out, the real index untouched.
 {
  const cwd=repo();
  const options={...at,cwd};
  assert.equal(contentTree(options),git(cwd,'rev-parse','HEAD^{tree}'),'a clean checkout is its HEAD tree');
  write(cwd,'ignored/x.txt','scratch');
  assert.equal(contentTree(options),git(cwd,'rev-parse','HEAD^{tree}'),'ignored files are not content');
  write(cwd,'tests/new.mjs','// new\n');
  write(cwd,'src/a.js','export const a=2;\n');
  const dirty=contentTree(options);
  assert.notEqual(dirty,git(cwd,'rev-parse','HEAD^{tree}'));
  assert.equal(git(cwd,'status','--porcelain','-uall'),'M src/a.js\n?? tests/new.mjs','the real index is untouched');
  git(cwd,'add','-A');
  git(cwd,'commit','-qm','two');
  assert.equal(git(cwd,'rev-parse','HEAD^{tree}'),dirty,'committing what was tested gives the tested tree');
  assert.equal(contentTree({...at,cwd:scratch}),null,'outside a work tree there is no content tree');
 }

 // 1b. Review of PR #1007: an index flag must not hide an edit. With assume-unchanged or skip-worktree on a tracked file and the file edited on disk,
 // `git add -A` over a copy of the index kept the old blob and attested HEAD's tree for bytes that were never tested. The snapshot starts from an empty
 // index, so it hashes what is on disk, and the real index keeps its flags.
 {
  for(const flag of ['--assume-unchanged','--skip-worktree']){
   const cwd=repo();
   const options={...at,cwd};
   const head=git(cwd,'rev-parse','HEAD^{tree}');
   git(cwd,'update-index',flag,'src/a.js');
   write(cwd,'src/a.js','export const a="untested";\n');
   assert.equal(git(cwd,'status','--porcelain'),'','the flag hides the edit from git status');
   const tree=contentTree(options);
   assert.notEqual(tree,head,`${flag}: the hidden edit is in the snapshot`);
   appendRecord(recordPath(options),{tree});
   assert.equal(coveringRecord('HEAD',options),null,`${flag}: a pass on the hidden edit does not cover HEAD`);
   assert.deepEqual(uncoveredByWorkingTree(['HEAD'],options),['HEAD'],`${flag}: the working tree does not stand for HEAD`);
   assert.match(git(cwd,'ls-files','-v','src/a.js'),flag==='--assume-unchanged'?/^h /:/^S /,'the real index keeps its flag');
  }
 }

 // 1c. Changed paths are raw and rename-blind: a move out of an executable path lists the old path, a non-ASCII name is not quoted, an error is null.
 {
  const cwd=repo();
  const options={...at,cwd};
  const before=git(cwd,'rev-parse','HEAD');
  git(cwd,'mv','src/a.js','docs/moved.md');
  git(cwd,'commit','-qm','move');
  const moved=changedPaths(before,'HEAD',options);
  assert.deepEqual([...moved].sort(),['docs/moved.md','src/a.js'],'the rename shows both sides');
  assert.equal(touchesExecutable(moved),true,'moving code into docs needs the suite');
  write(cwd,'src/\u00e9t\u00e9 \"q\".js','export const b=1;\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','odd name');
  const odd=changedPaths('HEAD~1','HEAD',options);
  assert.deepEqual(odd,['src/\u00e9t\u00e9 \"q\".js'],'the name comes back raw, not quoted');
  assert.equal(touchesExecutable(odd),true);
  assert.equal(changedPaths('HEAD','no-such-ref',options),null);
  assert.equal(touchesExecutable(null),true,'an unreadable change needs the suite');
  write(cwd,'docs/only.md','# only\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','docs');
  assert.equal(touchesExecutable(changedPaths('HEAD~1','HEAD',options)),false,'a documentation-only change does not');
 }

 // 2. Records: newest last, one line per tree and Node version, at most RECORD_LIMIT, junk lines ignored, and a missing file reads as none.
 {
  const cwd=repo();
  const file=recordPath({...at,cwd});
  assert.equal(file,path.join(cwd,'.git','iptv-test-all-passed'));
  assert.deepEqual(readRecords(file),[]);
  for(let index=0;index<RECORD_LIMIT+5;index++)appendRecord(file,{tree:index.toString(16).padStart(40,'0'),node:'v22.0.0',at:'2026-11-25T00:00:00Z'});
  const repeated=(RECORD_LIMIT+4).toString(16).padStart(40,'0');
  appendRecord(file,{tree:repeated,node:'v22.0.0',at:'2026-11-25T01:00:00Z'});
  const records=readRecords(file);
  assert.equal(records.length,RECORD_LIMIT);
  assert.equal(records[0].tree,(5).toString(16).padStart(40,'0'),'the oldest records are dropped');
  assert.equal(records.at(-1).at,'2026-11-25T01:00:00Z','a repeated tree moves to the end');
  assert.equal(records.filter(record=>record.tree===repeated).length,1,'one line per tree and Node version');
  fs.appendFileSync(file,'not a record\n\n');
  assert.equal(readRecords(file).length,RECORD_LIMIT);
 }

 // 3. Coverage: the exact tree, or a tree that differs only in files outside EXECUTABLE_PATHS; never an executable change, another Node version, or no record.
 {
  const cwd=repo();
  const options={...at,cwd,node:'v22.1.0'};
  const file=recordPath(options);
  assert.equal(coveringRecord('HEAD',options),null,'no record, no coverage');
  appendRecord(file,{tree:contentTree(options),node:'v22.1.0'});
  assert.equal(coveringRecord('HEAD',options).exact,true);
  assert.equal(coveringRecord('HEAD',{...options,node:'v20.0.0'}),null,'a pass on another Node version does not cover');
  write(cwd,'docs/a.md','# changed\n');
  write(cwd,'README.md','readme\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','docs');
  const docs=coveringRecord('HEAD',options);
  assert.equal(docs.exact,false);
  assert.equal(docs.changed,2,'a documentation-only difference is covered');
  for(const executable of ['src/a.js','tests/t.mjs','scripts/s.mjs','migrations/0001.sql','package.json','.githooks/pre-push','.github/workflows/ci.yml','wrangler.jsonc','build.mjs']){
   assert.ok(EXECUTABLE_PATHS.test(executable),executable);
  }
  write(cwd,'src/a.js','export const a=3;\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','code');
  assert.equal(coveringRecord('HEAD',options),null,'an untested source change is not covered');
  assert.equal(coveringRecord('no-such-ref',options),null);
  // A recorded tree, then a commit that only moves code into docs/ or adds an odd-named source file: neither is covered.
  appendRecord(file,{tree:git(cwd,'rev-parse','HEAD^{tree}'),node:'v22.1.0'});
  git(cwd,'mv','src/a.js','docs/a-code.md');
  git(cwd,'commit','-qm','move code out');
  assert.equal(coveringRecord('HEAD',options),null,'an executable-to-docs rename is not documentation-only');
  git(cwd,'reset','-q','--hard','HEAD~1');
  write(cwd,'src/\u00f1 x.js','export const n=1;\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','odd');
  assert.equal(coveringRecord('HEAD',options),null,'a quoted non-ASCII source name is not documentation-only');
 }

 // 4. The pre-push hook end to end, with this checkout's hook and record module. The stand-in `npm run test:all` leaves a marker and, like the real
 // runner, records the working tree it ran on (unless STAND_IN_NO_RECORD, which plays a run whose tree changed under it).
 {
  const cwd=repo();
  fs.mkdirSync(path.join(cwd,'.githooks'));
  fs.copyFileSync(path.join(repoRoot,'.githooks/pre-push'),path.join(cwd,'.githooks/pre-push'));
  write(cwd,'scripts/test-pass-record.mjs',fs.readFileSync(path.join(repoRoot,'scripts/test-pass-record.mjs'),'utf8'));
  write(cwd,'stand-in.mjs',"import fs from 'node:fs';import {appendRecord,contentTree,recordPath} from './scripts/test-pass-record.mjs';\nfs.writeFileSync('ran',process.argv.slice(2).join(' '));\nif(!process.env.STAND_IN_NO_RECORD)appendRecord(recordPath(),{tree:contentTree()});\n");
  write(cwd,'package.json',JSON.stringify({name:'t',private:true,scripts:{'test:all':'node stand-in.mjs'}}));
  git(cwd,'add','-A');git(cwd,'commit','-qm','hook');
  const base=git(cwd,'rev-parse','HEAD');
  git(cwd,'update-ref','refs/remotes/origin/main',base);
  const record=recordPath({...at,cwd});
  const clear=()=>fs.rmSync(record,{force:true});
  const hook=(refs,extra={})=>{
   fs.rmSync(path.join(cwd,'ran'),{force:true});
   const input=refs.map(([name,sha])=>`refs/heads/${name} ${sha} refs/heads/${name} ${'0'.repeat(40)}\n`).join('');
   const result=spawnSync('bash',['.githooks/pre-push','origin','url'],{cwd,env:{...env,...extra},input,encoding:'utf8'});
   return {status:result.status,ran:fs.existsSync(path.join(cwd,'ran')),out:result.stdout,err:result.stderr};
  };
  const commit=(file,text,message)=>{write(cwd,file,text);git(cwd,'add','-A');git(cwd,'commit','-qm',message);return git(cwd,'rev-parse','HEAD');};

  // The normal fallback: no record, the working tree is the pushed commit, the suite runs and records it.
  const head=commit('src/a.js','export const a=4;\n','change');
  let result=hook([['f',head]]);
  assert.deepEqual([result.status,result.ran],[0,true],result.err+result.out);
  // A recorded pass is not repeated, and names the covering run.
  result=hook([['f',head]]);
  assert.deepEqual([result.status,result.ran],[0,false],result.err);
  assert.match(result.out,/\[AIR-668\] pre-push: core and non-functional suites already passed on this content/);
  assert.match(result.out,new RegExp(head.slice(0,12)));
  // IPTV_PREPUSH_RERUN=1 runs it on the matching working tree.
  assert.deepEqual([hook([['f',head]],{IPTV_PREPUSH_RERUN:'1'}).status,fs.existsSync(path.join(cwd,'ran'))],[0,true]);
  // A later documentation-only commit stays covered; a later test change runs the suite.
  const docs=commit('docs/a.md','# later\n','docs later');
  assert.deepEqual(Object.values(hook([['f',docs]])).slice(0,2),[0,false]);
  const tests=commit('tests/x.mjs','// x\n','test later');
  assert.deepEqual(Object.values(hook([['f',tests]])).slice(0,2),[0,true]);

  // The early documentation-only exemption is rename-blind and reads raw names (review of PR #1007).
  git(cwd,'update-ref','refs/remotes/origin/main',git(cwd,'rev-parse','HEAD'));
  clear();
  const moved=(()=>{git(cwd,'mv','src/a.js','docs/a-code.md');git(cwd,'commit','-qm','move code out');return git(cwd,'rev-parse','HEAD');})();
  result=hook([['f',moved]]);
  assert.deepEqual([result.status,result.ran],[0,true],'moving code into docs/ runs the suite');
  assert.doesNotMatch(result.out,/documentation-only/);
  git(cwd,'update-ref','refs/remotes/origin/main',moved);
  clear();
  const odd=commit('src/é "q".js','export const e=1;\n','odd name');
  assert.deepEqual(Object.values(hook([['f',odd]])).slice(0,2),[0,true],'an odd-named source file runs the suite');
  git(cwd,'update-ref','refs/remotes/origin/main',odd);
  const docsOnly=commit('docs/b.md','# b\n','docs only');
  result=hook([['f',docsOnly]]);
  assert.deepEqual([result.status,result.ran],[0,false]);
  assert.match(result.out,/documentation-only change/,'a documentation-only push still skips');

  // A miss for content that is not checked out stops the push without running anything (review of PR #1007).
  clear();
  git(cwd,'update-ref','refs/remotes/origin/main',base);
  git(cwd,'checkout','-q','-b','other',base);
  const other=commit('src/other.js','export const o=1;\n','other branch');
  git(cwd,'checkout','-q','main');
  result=hook([['other',other]]);
  assert.deepEqual([result.status,result.ran],[1,false],'an uncovered ref that is not checked out fails closed');
  assert.match(result.err,/not the content of these pushed commits/);
  assert.match(result.err,new RegExp(other));
  result=hook([['other',other]],{IPTV_PREPUSH_RERUN:'1'});
  assert.deepEqual([result.status,result.ran],[1,false],'a forced run does not bless another commit');
  // Two distinct uncovered refs: the working tree can stand for one of them at most.
  result=hook([['main',docsOnly],['other',other]]);
  assert.deepEqual([result.status,result.ran],[1,false],'two distinct uncovered refs fail closed');
  assert.match(result.err,new RegExp(other));
  assert.doesNotMatch(result.err,new RegExp(docsOnly),'the checked-out one is not named');
  // A covered ref beside an uncovered one is still refused.
  appendRecord(record,{tree:git(cwd,'rev-parse',`${docsOnly}^{tree}`)});
  assert.deepEqual(Object.values(hook([['main',docsOnly],['other',other]])).slice(0,2),[1,false]);
  clear();
  // Uncommitted executable edits: the working tree is not the pushed commit.
  write(cwd,'src/a2.js','export const dirty=1;\n');
  result=hook([['main',docsOnly]]);
  assert.deepEqual([result.status,result.ran],[1,false],'a dirty executable working tree fails closed');
  fs.rmSync(path.join(cwd,'src/a2.js'));
  // An untracked documentation file beside the commit is fine.
  write(cwd,'notes.md','scratch\n');
  assert.deepEqual(Object.values(hook([['main',docsOnly]])).slice(0,2),[0,true]);
  fs.rmSync(path.join(cwd,'notes.md'));
  // A run that records nothing (its tree changed under it) does not let the push through.
  clear();
  result=hook([['main',docsOnly]],{STAND_IN_NO_RECORD:'1'});
  assert.deepEqual([result.status,result.ran],[1,true],'a run without a covering record stops the push');
  assert.match(result.err,/not on the content of every pushed commit/);
 }

 // 5. The runner records a passing `--suite all` of a repository's own tests directory, and nothing for a failure, a --dir run or IPTV_TEST_PASS_RECORD=0.
 {
  const runner=path.join(repoRoot,'scripts/run-tests.mjs');
  const cwd=repo();
  write(cwd,'tests/a.mjs','// passes\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','tests');
  const file=recordPath({...at,cwd});
  const run=(args,extra={})=>spawnSync(process.execPath,[runner,...args],{cwd,env:{...env,...extra},encoding:'utf8'});
  let result=run(['--suite','all'],{IPTV_TEST_PASS_RECORD:'0'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(readRecords(file),[],'IPTV_TEST_PASS_RECORD=0 records nothing');
  const other=path.join(cwd,'other');
  write(cwd,'other/a.mjs','// passes\n');
  result=run(['--suite','all','--dir',other]);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(readRecords(file),[],'a --dir run records nothing');
  fs.rmSync(other,{recursive:true});
  result=run(['--suite','all']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Recorded the pass of tree/);
  assert.deepEqual(readRecords(file).map(record=>[record.tree,record.node]),[[git(cwd,'rev-parse','HEAD^{tree}'),process.version]]);
  result=run(['--suite','core']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(readRecords(file).length,1,'a core-only run records nothing');
  write(cwd,'tests/b.mjs','process.exit(1);\n');
  result=run(['--suite','all']);
  assert.notEqual(result.status,0);
  assert.equal(readRecords(file).length,1,'a failed run records nothing');
  write(cwd,'tests/b.mjs',"require('node:fs');\n".replace("require('node:fs');","import fs from 'node:fs'; fs.writeFileSync('changed.txt','x');"));
  result=run(['--suite','all']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/working tree changed during the run/);
  assert.equal(readRecords(file).length,1,'a run whose working tree changed records nothing');
 }
 console.log('test pass record tests passed');
}finally{
 fs.rmSync(scratch,{recursive:true,force:true});
}
