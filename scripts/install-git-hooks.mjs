#!/usr/bin/env node
// AIR-514: setup is local to this checkout and preserves unrelated hook managers.
import {execFileSync} from 'node:child_process';
import path from 'node:path';
function git(args,cwd=process.cwd()){
 return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
let root;
try{root=git(['rev-parse','--show-toplevel']);}
catch{console.log('Git hooks: no local checkout, skipped.');process.exit(0);}
const desired='.githooks';
let existing='';
try{existing=git(['config','--local','--get','core.hooksPath'],root);}catch{}
if(existing&&existing!==desired&&path.resolve(root,existing)!==path.join(root,desired)){
 console.error('Git hooks: another core.hooksPath is configured ('+existing+').');
 console.error('Integrate .githooks manually. Refusing to overwrite existing hooks.');
 process.exit(1);
}
git(['config','--local','core.hooksPath',desired],root);
console.log('Git hooks active: '+desired+' (local repository only).');
