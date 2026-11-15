// AIR-490. The core and non-functional suites are a partition of the runnable files, plus the split files that carry both.
// A new tests/*.mjs file fails here until it is named in scripts/test-classification.mjs. A runner wall-clock assertion of the known shapes fails here in a core file.
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {CORE_REASON,FILES,SUITES,selectSuite} from '../scripts/test-classification.mjs';
import {FIXTURE_DEPENDENT,planTests} from '../scripts/run-tests.mjs';
import {nonFunctional} from './suite-gate.mjs';

const SCENARIOS={
 'catalog-d1-identity-read-latency':{file:'catalog-d1.mjs',marker:'elapsed<5000'},
 'discovery-chunk-budget-concurrent-walk':{file:'discovery-chunk-budget.mjs',marker:'concurrentMs<sequentialMs*0.7'},
 'discovery-user-read-fence-slow-catalog':{file:'discovery-user-read-fence.mjs',marker:'Date.now()-started>=80'},
 'film-person-reader-completed-slots-index':{file:'film-person-reader.mjs',marker:'Date.now()-at<8000'},
 'footer-resilience-hung-freshness':{file:'footer-resilience.mjs',marker:'Date.now()-started<3000'},
 'footer-resilience-silent-source':{file:'footer-resilience.mjs',marker:'took<3000'},
 'prediction-batch-submit-wall':{file:'prediction-batch-submit.mjs',marker:'ms<15000'},
 'prediction-batch-validate-p95':{file:'prediction-batch-validate.mjs',marker:'p95<100'},
 'prediction-step-timing-overhead':{file:'prediction-step-timing.mjs',marker:'timed-base<0.25'},
};

const names=readdirSync('tests').filter(file=>file.endsWith('.mjs')).sort();
assert.deepEqual(Object.keys(FILES).sort(),names,'the registry is exactly the tests directory, once');
for(const [file,entry] of Object.entries(FILES)){
 assert.ok(SUITES.includes(entry.suite),file);
 if(entry.suite==='core'&&entry.note===undefined)continue;
 assert.equal(typeof entry.note,'string',file+' needs a reason');
 assert.ok(entry.note.length>40,file);
}
assert.ok(CORE_REASON.includes('wall-clock')&&CORE_REASON.includes('mutant'));
assert.deepEqual(names.filter(file=>FILES[file].suite==='fixture').sort(),[...FIXTURE_DEPENDENT].sort(),'fixture files are the historical exclusions');

for(const file of names.filter(item=>FILES[item].suite==='support')){
 const importers=names.filter(other=>other!==file&&readFileSync(path.join('tests',other),'utf8').includes("'"+file+"'")||readFileSync(path.join('tests',other),'utf8').includes('./'+file));
 assert.ok(importers.length>0,file+' is imported by a test');
}

const filesOf=plan=>[...plan.parallel,...plan.serial].sort();
const core=filesOf(planTests({directory:'tests',suite:'core'}));
const night=filesOf(planTests({directory:'tests',suite:'non-functional'}));
const all=filesOf(planTests({directory:'tests',suite:'all'}));
const by=suite=>names.filter(file=>FILES[file].suite===suite);
const split=new Set(by('split'));
assert.deepEqual(core.filter(file=>!split.has(file)),by('core').sort());
assert.deepEqual(night.filter(file=>!split.has(file)),by('non-functional').sort());
assert.deepEqual(core.filter(file=>night.includes(file)).sort(),[...split].sort(),'only split files are in both suites');
assert.deepEqual(all,names.filter(file=>FILES[file].suite!=='support'&&FILES[file].suite!=='fixture').sort(),'the two suites together are every runnable file');
for(const count of [1,3]){
 const parts=[];
 for(let index=1;index<=count;index++)parts.push(...filesOf(planTests({directory:'tests',suite:'core',shard:{index,count}})));
 assert.deepEqual(parts.sort(),core,`core shards of ${count} cover the core suite once`);
 for(const file of by('non-functional'))assert.ok(!parts.includes(file),file+' is not in a core shard');
}
assert.throws(()=>selectSuite(['brand-new-air-490.mjs'],'tests','core'),/unclassified/);
assert.deepEqual(selectSuite(['brand-new-air-490.mjs'],'not-the-repo-tests','non-functional'),['brand-new-air-490.mjs'],'a fixture directory is not filtered');

let ran=false;
const previous=process.env.IPTV_TEST_SUITE;
process.env.IPTV_TEST_SUITE='core';
const gate=nonFunctional;
gate('gate-core',()=>{ran=true;});
assert.equal(ran,false,'a performance check does not run in the core suite, so it cannot fail a deploy');
process.env.IPTV_TEST_SUITE='non-functional';
gate('gate-night',()=>{ran=true;});
assert.equal(ran,true,'the same performance check runs in the non-functional suite');
if(previous===undefined)delete process.env.IPTV_TEST_SUITE;else process.env.IPTV_TEST_SUITE=previous;

function callback(source,id){
 const token='nonFunctional'+"('"+id+"'";
 const at=source.indexOf(token);
 assert.ok(at>=0,id+' is called');
 assert.equal(source.indexOf(token,at+token.length),-1,id+' is called once');
 let depth=0;
 for(let index=source.indexOf('{',source.indexOf('=>',at));index<source.length;index++){
  if(source[index]==='{')depth++;
  else if(source[index]==='}'){depth--;if(depth===0)return {body:source.slice(source.indexOf('{',source.indexOf('=>',at)),index+1),start:source.indexOf('{',source.indexOf('=>',at)),end:index};}
 }
 throw new Error('unclosed '+id);
}
const calls=new Map();
for(const file of names){
 const source=readFileSync(path.join('tests',file),'utf8');
 const ids=[...source.matchAll(/nonFunctional\('([^']+)'/g)].map(match=>match[1]);
 if(ids.length)calls.set(file,ids);
}
assert.deepEqual([...calls.keys()].sort(),[...split].sort(),'only split files declare non-functional scenarios');
assert.deepEqual([...calls.values()].flat().sort(),Object.keys(SCENARIOS).sort());
for(const [id,spec] of Object.entries(SCENARIOS)){
 assert.equal(FILES[spec.file].suite,'split',id);
 const source=readFileSync(path.join('tests',spec.file),'utf8');
 const span=callback(source,id);
 assert.ok(span.body.includes(spec.marker),id+' keeps its check');
 assert.ok(!(source.slice(0,span.start)+source.slice(span.end+1)).includes(spec.marker),id+' is not also asserted in the core path');
}

const wall=/assert\.(?:ok|equal|notEqual|deepEqual)\([^;\n]*(?:Date\.now\(\)\s*-|performance\.now\(\)|hrtime|p95\s*<)/;
for(const file of by('core')){
 readFileSync(path.join('tests',file),'utf8').split('\n').forEach((line,index)=>{
  assert.ok(!wall.test(line),`${file}:${index+1} is a runner wall-clock assertion in the core suite`);
 });
}
for(const file of by('non-functional')){
 const source=readFileSync(path.join('tests',file),'utf8');
 assert.ok(/mutants that no test kills|runMutationPart\(/.test(source),file+' is a mutant-kill check');
 assert.equal([...source.matchAll(/nonFunctional\('/g)].length,0,file+' is wholly non-functional');
}

console.log(`test classification: ${names.length} files, core ${by('core').length}, non-functional ${by('non-functional').length}, split ${split.size}, ${Object.keys(SCENARIOS).length} gated checks`);
