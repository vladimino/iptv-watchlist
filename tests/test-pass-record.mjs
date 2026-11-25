// AIR-668: the pass record the pre-push hook reads. A `--suite all` run that passes on an unchanged working tree records that tree; the hook skips the
// suite only for a pushed commit whose tree was recorded, or differs from a recorded tree only outside the paths that need the suite. Everything is
// exercised in throwaway Git repositories, never in this checkout.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EXECUTABLE_PATHS,RECORD_LIMIT,appendRecord,contentTree,coveringRecord,readRecords,recordPath} from '../scripts/test-pass-record.mjs';

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
 }

 // 4. The pre-push hook end to end, with this checkout's hook and record module and a stand-in `npm run test:all` that leaves a marker.
 {
  const cwd=repo();
  fs.mkdirSync(path.join(cwd,'.githooks'));
  fs.copyFileSync(path.join(repoRoot,'.githooks/pre-push'),path.join(cwd,'.githooks/pre-push'));
  write(cwd,'scripts/test-pass-record.mjs',fs.readFileSync(path.join(repoRoot,'scripts/test-pass-record.mjs'),'utf8'));
  write(cwd,'stand-in.cjs',"require('node:fs').writeFileSync('ran',process.argv.slice(2).join(' '));\n");
  write(cwd,'package.json',JSON.stringify({name:'t',private:true,scripts:{'test:all':'node stand-in.cjs'}}));
  git(cwd,'add','-A');git(cwd,'commit','-qm','hook');
  const base=git(cwd,'rev-parse','HEAD');
  git(cwd,'update-ref','refs/remotes/origin/main',base);
  const push=(sha,extra={})=>{
   fs.rmSync(path.join(cwd,'ran'),{force:true});
   const result=spawnSync('bash',['.githooks/pre-push','origin','url'],{cwd,env:{...env,...extra},input:`refs/heads/f ${sha} refs/heads/f ${'0'.repeat(40)}\n`,encoding:'utf8'});
   assert.equal(result.status,0,result.stderr+result.stdout);
   return {ran:fs.existsSync(path.join(cwd,'ran')),out:result.stdout};
  };
  write(cwd,'src/a.js','export const a=4;\n');
  const tested=contentTree({...at,cwd});
  git(cwd,'add','-A');git(cwd,'commit','-qm','change');
  const head=git(cwd,'rev-parse','HEAD');
  assert.equal(push(head).ran,true,'without a record the hook runs the suite');
  appendRecord(recordPath({...at,cwd}),{tree:tested});
  const skipped=push(head);
  assert.equal(skipped.ran,false,'a recorded pass of the pushed content is not repeated');
  assert.match(skipped.out,/\[AIR-668\] pre-push: core and non-functional suites already passed on this content/);
  assert.match(skipped.out,new RegExp(head.slice(0,12)));
  assert.equal(push(head,{IPTV_PREPUSH_RERUN:'1'}).ran,true,'IPTV_PREPUSH_RERUN=1 always runs the suite');
  write(cwd,'docs/a.md','# later\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','docs later');
  assert.equal(push(git(cwd,'rev-parse','HEAD')).ran,false,'a later documentation-only commit stays covered');
  write(cwd,'tests/x.mjs','// x\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','test later');
  assert.equal(push(git(cwd,'rev-parse','HEAD')).ran,true,'a later executable change runs the suite');
  write(cwd,'docs/b.md','# b\n');
  git(cwd,'add','-A');git(cwd,'commit','-qm','docs only');
  const docsOnly=git(cwd,'rev-parse','HEAD');
  git(cwd,'update-ref','refs/remotes/origin/main',git(cwd,'rev-parse','HEAD~1'));
  const docsPush=push(docsOnly);
  assert.equal(docsPush.ran,false);
  assert.match(docsPush.out,/documentation-only change/,'the documentation-only rule is unchanged');
  // One covered ref and one uncovered ref in the same push: the suite runs.
  git(cwd,'update-ref','refs/remotes/origin/main',base);
  fs.rmSync(path.join(cwd,'ran'),{force:true});
  const both=spawnSync('bash',['.githooks/pre-push','origin','url'],{cwd,env,encoding:'utf8',input:`refs/heads/a ${head} refs/heads/a ${'0'.repeat(40)}\nrefs/heads/b ${docsOnly} refs/heads/b ${'0'.repeat(40)}\n`});
  assert.equal(both.status,0,both.stderr);
  assert.equal(fs.existsSync(path.join(cwd,'ran')),true,'every pushed commit must be covered');
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
