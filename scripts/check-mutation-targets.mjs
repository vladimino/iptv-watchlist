#!/usr/bin/env node
// AIR-514: fast static anchor checks, no mutation workload or fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const HARNESSES=[
 {path:'tests/canonical-producer-driver-mutation-lib.mjs',definitions:['DRIVER','SKIP']},
 {path:'tests/canonical-producer-store-mutation.mjs',definitions:[]},
];
function sourceAnchors(source,definitions){
 const marker='const MUTANTS=[';
 const start=source.indexOf(marker);
 if(start<0||source.indexOf(marker,start+1)>=0)throw new Error('expected one const MUTANTS=[ declaration');
 const end=source.indexOf('\n];',start);
 if(end<0)throw new Error('missing MUTANTS array terminator');
 const prologue=definitions.map(name=>{
  const match=new RegExp('^const '+name+'=.*;$','m').exec(source);
  if(!match)throw new Error('missing declaration: '+name);
  return match[0];
 }).join('\n');
 const mutants=vm.runInNewContext(prologue+'\n'+source.slice(start,end+3)+'\nMUTANTS;',Object.create(null),{timeout:1000});
 if(!Array.isArray(mutants)||mutants.length===0)throw new Error('MUTANTS must contain entries');
 return mutants;
}
function count(source,fragment){
 if(typeof fragment!=='string'||!fragment)throw new Error('empty mutation anchor');
 return source.split(fragment).length-1;
}
function validate(root=ROOT,harnesses=HARNESSES){
 const errors=[],cache=new Map();
 let targets=0;
 for(const harness of harnesses){
  try{
   const mutants=sourceAnchors(fs.readFileSync(path.join(root,harness.path),'utf8'),harness.definitions);
   for(const [name,file,anchor] of mutants){
    if(typeof name!=='string'||typeof file!=='string'||!file.endsWith('.js')||file.includes('/')||file.includes('..')){
     errors.push(harness.path+': malformed mutation entry '+String(name));
     continue;
    }
    const sourcePath='src/'+file;
    try{
     if(!cache.has(sourcePath))cache.set(sourcePath,fs.readFileSync(path.join(root,sourcePath),'utf8'));
     const matches=count(cache.get(sourcePath),anchor);
     targets++;
     if(matches!==1)errors.push(harness.path+': '+JSON.stringify(name)+' in '+sourcePath+' matches '+matches+' times (expected exactly 1)');
    }catch(error){errors.push(harness.path+': '+JSON.stringify(name)+': '+error.message);}
   }
  }catch(error){errors.push(harness.path+': '+error.message);}
 }
 return {targets,errors};
}
function selfTest(){
 assert.equal(count('before needle after','needle'),1);
 assert.equal(count('before after','needle'),0);
 assert.equal(count('needle + needle','needle'),2);
 const sample='const MUTANTS=[\n ["test","sample.js","needle","replacement"],\n];\n';
 assert.equal(sourceAnchors(sample,[])[0][2],'needle');
 assert.throws(()=>sourceAnchors('const X=1;',[]),/expected one/);
 console.log('Mutation target preflight self-test: PASS');
}
if(process.argv.includes('--self-test'))selfTest();
else{
 const result=validate();
 if(result.errors.length){
  for(const message of result.errors)console.error('FAIL '+message);
  console.error('Mutation target preflight FAILED: '+result.errors.length+' mismatches across '+result.targets+' anchors.');
  process.exitCode=1;
 }else console.log('Mutation target preflight PASS: '+result.targets+' anchors across '+HARNESSES.length+' harnesses.');
}
