// AIR-471: differential check of batch_start between a baseline commit and the current tree, offline (sqlite D1 stand-in, in-memory R2).
//   node scripts/prediction-batch-start-diff.mjs [--ref <commit>] [--write-baseline]
// It checks the baseline out into a temporary git worktree, runs tests/prediction-batch-start-parity-lib.mjs there and here, compares every scenario's normalized
// result, and prints the counts, bytes and wall time of both. `--write-baseline` stores the baseline result as tests/fixtures/prediction-batch-start-parity-baseline.json,
// which tests/prediction-batch-start-parity.mjs compares the current tree with. Wall time is a local figure and does not predict Cloudflare latency. No production access.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import assert from 'node:assert/strict';

const args=process.argv.slice(2),ref=args.includes('--ref')?args[args.indexOf('--ref')+1]:'f314b339',write=args.includes('--write-baseline');
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-batch-diff-'));
const run=cwd=>JSON.parse(execFileSync('node',['tests/prediction-batch-start-parity-lib.mjs'],{cwd,encoding:'utf8',maxBuffer:1<<28}));
let base;
try{
 execFileSync('git',['worktree','add','--detach',dir+'/base',ref],{cwd:root,stdio:'ignore'});
 fs.symlinkSync(path.join(root,'node_modules'),dir+'/base/node_modules','dir');
 fs.copyFileSync('tests/prediction-batch-start-parity-lib.mjs',dir+'/base/tests/prediction-batch-start-parity-lib.mjs');
 base=run(dir+'/base');
}finally{try{execFileSync('git',['worktree','remove','--force',dir+'/base'],{cwd:root,stdio:'ignore'});}catch{/* the temporary directory is removed below */}fs.rmSync(dir,{recursive:true,force:true});}
const head=run(root);
if(write){fs.writeFileSync('tests/fixtures/prediction-batch-start-parity-baseline.json',JSON.stringify({ref,results:base.results,metrics:Object.fromEntries(Object.entries(base.metrics).map(([k,v])=>[k,v&&{r2:v.r2,d1:v.d1,statements:v.statements,bytes:v.bytes}]))},null,1)+'\n');console.log('baseline written for '+ref);}
const rows=[];let differing=[];
for(const name of Object.keys(base.results)){
 const same=JSON.stringify(base.results[name])===JSON.stringify(head.results[name]);if(!same)differing.push(name);
 const a=base.metrics[name],b=head.metrics[name];
 rows.push('| '+[name,same?'identical':'DIFFERENT',a?a.r2+' -> '+b.r2:'-',a?a.d1+' -> '+b.d1:'-',a?a.bytes+' -> '+b.bytes:'-',a?a.wallMs+' -> '+b.wallMs:'-'].join(' | ')+' |');
}
console.log('| scenario | result vs '+ref+' | R2 calls | D1 calls | R2 bytes | offline wall ms |\n| --- | --- | --- | --- | --- | --- |\n'+rows.join('\n'));
console.log('differing scenarios: '+(differing.join(', ')||'none'));
