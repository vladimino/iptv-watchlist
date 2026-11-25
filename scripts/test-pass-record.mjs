// AIR-668: a local record of the content a full `--suite all` run passed on, so the pre-push hook does not run the same suite again on the same code.
//
// The pre-PR rule asks for `npm run test:all` on the final checkout, and the pre-push hook then ran the whole suite a second time on the same content
// (25 Nov 2026, PR #1003: about 6 minutes by hand, then 9 min 40 s inside `git push`). The runner now writes the Git tree of the working tree it tested
// (tracked and untracked files that are not ignored, the same files the suite reads) to a file in the Git directory, but only when the run passed in full
// and the tree was the same when the run ended as when it began. The hook skips the suite when every pushed commit's tree is one of those trees, or
// differs from one only in files that do not need the suite (the hook's own documentation-only rule). Anything else runs the suite as before.
//
// This is a local convenience, not evidence: like the hook itself it can be bypassed, and CI still runs the required core suite on every PR.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,copyFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const RECORD_NAME='iptv-test-all-passed';
export const RECORD_LIMIT=50;
// The same paths the hook treats as needing the suite (.githooks/pre-push keeps its own copy for its documentation-only check).
export const EXECUTABLE_PATHS=/^(src\/|scripts\/|tests\/|migrations\/|public\/|data\/|build\.mjs$|package(-lock)?\.json$|wrangler\.jsonc$|\.github\/workflows\/|\.githooks\/)/;

const git=(args,{cwd,env})=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();

export function recordPath({cwd=process.cwd(),env=process.env}={}){
 try{return path.resolve(cwd,git(['rev-parse','--git-path',RECORD_NAME],{cwd,env}));}catch{return null;}
}

// The tree of everything `git add -A` would stage, built in a copy of the index so the real index is left alone. Null outside a Git work tree.
export function contentTree({cwd=process.cwd(),env=process.env}={}){
 let scratch=null;
 try{
  const top=git(['rev-parse','--show-toplevel'],{cwd,env});
  const index=path.resolve(top,git(['rev-parse','--git-path','index'],{cwd:top,env}));
  scratch=mkdtempSync(path.join(tmpdir(),'iptv-pass-record-'));
  const copy=path.join(scratch,'index');
  if(existsSync(index))copyFileSync(index,copy);
  const scoped={...env,GIT_INDEX_FILE:copy};
  git(['add','-A','.'],{cwd:top,env:scoped});
  return git(['write-tree'],{cwd:top,env:scoped});
 }catch{return null;}
 finally{if(scratch)rmSync(scratch,{recursive:true,force:true});}
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

// A commit is covered when a passing run on this Node version tested its exact tree, or a tree that differs from it only outside EXECUTABLE_PATHS.
export function coveringRecord(commit,{cwd=process.cwd(),env=process.env,node=process.version}={}){
 const records=readRecords(recordPath({cwd,env})).filter(record=>record.node===node).reverse();
 if(!records.length)return null;
 let tree;
 try{tree=git(['rev-parse',`${commit}^{tree}`],{cwd,env});}catch{return null;}
 const exact=records.find(record=>record.tree===tree);
 if(exact)return {...exact,exact:true};
 for(const record of records){
  let changed;
  try{changed=git(['diff','--name-only',record.tree,tree],{cwd,env}).split('\n').filter(Boolean);}catch{continue;}
  if(!changed.some(file=>EXECUTABLE_PATHS.test(file)))return {...record,exact:false,changed:changed.length};
 }
 return null;
}

// `node scripts/test-pass-record.mjs check <commit>...`: exit 0 and name the record when every commit is covered, 1 otherwise. Used by .githooks/pre-push.
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 const [command,...commits]=process.argv.slice(2);
 if(command!=='check'||!commits.length){console.error('usage: node scripts/test-pass-record.mjs check <commit>...');process.exit(2);}
 const covered=[];
 for(const commit of commits){
  const record=coveringRecord(commit);
  if(!record){process.exitCode=1;break;}
  covered.push(`${commit.slice(0,12)} by the run of ${record.at} on tree ${record.tree.slice(0,12)}${record.exact?'':` (${record.changed} non-executable file${record.changed===1?'':'s'} differ)`}`);
 }
 if(!process.exitCode)console.log(covered.join('\n'));
}
