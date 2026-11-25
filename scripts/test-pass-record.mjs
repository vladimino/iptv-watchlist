// AIR-668: a local record of the content a full `--suite all` run passed on, so the pre-push hook does not run the same suite again on the same code.
//
// The pre-PR rule asks for `npm run test:all` on the final checkout, and the pre-push hook then ran the whole suite a second time on the same content
// (25 Nov 2026, PR #1003: about 6 minutes by hand, then 9 min 40 s inside `git push`). The runner now writes the Git tree of the working tree it tested
// (tracked and untracked files that are not ignored, the same files the suite reads) to a file in the Git directory, but only when the run passed in full
// and the tree was the same when the run ended as when it began. The hook skips the suite when every pushed commit's tree is one of those trees, or
// differs from one only in files that do not need the suite (the hook's own documentation-only rule). Anything else runs the suite as before, and only
// when the checked-out content is what is being pushed.
//
// Fail closed everywhere: a Git error, an unreadable path list or an unknown commit counts as an executable change and as not covered.
//
// This is a local convenience, not evidence: like the hook itself it can be bypassed, and CI still runs the required core suite on every PR.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const RECORD_NAME='iptv-test-all-passed';
export const RECORD_LIMIT=50;
// The paths whose change needs the suite. .githooks/pre-push asks this module (`classify`), so the hook and the record share one rule.
export const EXECUTABLE_PATHS=/^(src\/|scripts\/|tests\/|migrations\/|public\/|data\/|build\.mjs$|package(-lock)?\.json$|wrangler\.jsonc$|\.github\/workflows\/|\.githooks\/)/;
// The snapshot must hash the bytes on disk: no file-system monitor or untracked cache may vouch for a file.
const SNAPSHOT_CONFIG=['-c','core.fsmonitor=false','-c','core.untrackedCache=false'];

const git=(args,{cwd,env})=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024}).trim();

export function recordPath({cwd=process.cwd(),env=process.env}={}){
 try{return path.resolve(cwd,git(['rev-parse','--git-path',RECORD_NAME],{cwd,env}));}catch{return null;}
}

// The tree of everything `git add -A` would commit from the working tree as it is on disk. It is built in a new, empty index, never from the real one:
// a copied index would carry assume-unchanged and skip-worktree flags and cached stat data, under which an edited tracked file keeps its old blob and the
// tree would attest bytes that were never tested. Starting empty hashes every file that is not ignored. A file missing from disk (a sparse checkout) or
// a tracked file that matches .gitignore is simply absent from the tree, so the tree differs from the commit and nothing is covered. Null outside a Git
// work tree or on any Git error.
export function contentTree({cwd=process.cwd(),env=process.env}={}){
 let scratch=null;
 try{
  const top=git(['rev-parse','--show-toplevel'],{cwd,env});
  scratch=mkdtempSync(path.join(tmpdir(),'iptv-pass-record-'));
  const scoped={...env,GIT_INDEX_FILE:path.join(scratch,'index')};
  git([...SNAPSHOT_CONFIG,'add','-A','.'],{cwd:top,env:scoped});
  return git(['write-tree'],{cwd:top,env:scoped});
 }catch{return null;}
 finally{if(scratch)rmSync(scratch,{recursive:true,force:true});}
}

// The paths that differ between two tree-ish, raw (NUL-separated, never quoted) and without rename detection, so a file moved out of an executable
// path shows its old path too. Null on any error.
export function changedPaths(from,to,{cwd=process.cwd(),env=process.env}={}){
 try{
  const out=execFileSync('git',['diff','--no-renames','--no-ext-diff','--no-textconv','--name-only','-z',from,to,'--'],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024});
  return out.split('\0').filter(Boolean);
 }catch{return null;}
}

// True when the change needs the suite: an executable path, or a change that could not be listed.
export function touchesExecutable(paths){
 return paths===null||paths.some(file=>EXECUTABLE_PATHS.test(file));
}

export function readRecords(file){
 if(!file)return [];
 let text='';
 try{text=readFileSync(file,'utf8');}catch{return [];}
 return text.split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>/^[0-9a-f]{40,64}$/.test(parts[0]??'')).map(([tree,node,at])=>({tree,node,at}));
}

export function appendRecord(file,{tree,node=process.version,at=new Date().toISOString()}){
 if(!file||!tree)return false;
 const kept=readRecords(file).filter(record=>record.tree!==tree||record.node!==node);
 kept.push({tree,node,at});
 const lines=kept.slice(-RECORD_LIMIT).map(record=>`${record.tree} ${record.node} ${record.at}`);
 const temporary=`${file}.${process.pid}.tmp`;
 writeFileSync(temporary,lines.join('\n')+'\n');
 renameSync(temporary,file);
 return true;
}

function commitTree(commit,options){
 try{return git(['rev-parse','--verify','-q',`${commit}^{tree}`],options);}catch{return null;}
}

// A commit is covered when a passing run on this Node version tested its exact tree, or a tree that differs from it only outside EXECUTABLE_PATHS.
export function coveringRecord(commit,{cwd=process.cwd(),env=process.env,node=process.version}={}){
 const options={cwd,env};
 const records=readRecords(recordPath(options)).filter(record=>record.node===node).reverse();
 if(!records.length)return null;
 const tree=commitTree(commit,options);
 if(!tree)return null;
 const exact=records.find(record=>record.tree===tree);
 if(exact)return {...exact,exact:true};
 for(const record of records){
  const changed=changedPaths(record.tree,tree,options);
  if(!touchesExecutable(changed))return {...record,exact:false,changed:changed.length};
 }
 return null;
}

// The commits among `commits` whose content the working tree does not stand for: a run of the suite here would not have tested them. Null when the
// working tree cannot be read (then nothing is stood for).
export function uncoveredByWorkingTree(commits,{cwd=process.cwd(),env=process.env}={}){
 const options={cwd,env};
 const tree=contentTree(options);
 if(!tree)return null;
 return commits.filter(commit=>{
  const target=commitTree(commit,options);
  return !target||touchesExecutable(changedPaths(tree,target,options));
 });
}

// Command line, for .githooks/pre-push:
//   classify <base> <commit>    prints "executable" or "documentation" for the change between them; any error prints "executable"
//   check <commit>...           exit 0 and name the covering run when every commit is covered by a record, 1 otherwise
//   worktree <commit>...        exit 0 when the working tree stands for every commit, 1 (naming the others) otherwise
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 const [command,...rest]=process.argv.slice(2);
 if(command==='classify'&&rest.length===2){
  console.log(touchesExecutable(changedPaths(rest[0],rest[1]))?'executable':'documentation');
 }else if(command==='check'&&rest.length){
  const covered=[];
  for(const commit of rest){
   const record=coveringRecord(commit);
   if(!record){process.exitCode=1;break;}
   covered.push(`${commit.slice(0,12)} by the run of ${record.at} on tree ${record.tree.slice(0,12)}${record.exact?'':` (${record.changed} non-executable file${record.changed===1?'':'s'} differ)`}`);
  }
  if(!process.exitCode)console.log(covered.join('\n'));
 }else if(command==='worktree'&&rest.length){
  const missing=uncoveredByWorkingTree(rest);
  if(missing===null){console.log('the working tree could not be read');process.exitCode=1;}
  else if(missing.length){console.log(missing.join('\n'));process.exitCode=1;}
 }else{
  console.error('usage: node scripts/test-pass-record.mjs classify <base> <commit> | check <commit>... | worktree <commit>...');
  process.exitCode=2;
 }
}
