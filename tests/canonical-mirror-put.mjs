// AIR-499: titles.json / people.json R2 puts re-read the Film/Person freeze after epgStepGuard (and any routing await), at the BUCKET.put boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const worker=fs.readFileSync('src/worker.js','utf8');
const freeze=worker.slice(worker.indexOf('async function frozenCanonicalMirrorsLocked'),worker.indexOf('async function localizedTitleStore'));
const save=worker.slice(worker.indexOf('async function epgStepGuard'),worker.indexOf('function confirmedHalfStar'));
assert.match(freeze,/frozenCanonicalMirrorsLocked/);
assert.match(save,/async function putStoredJson/);
assert.match(save,/await epgStepGuard\(env\)/);
assert.doesNotMatch(save.replace(/async function putStoredJson[\s\S]*?\n\}/,''),/env\.BUCKET\.put/);

async function runSave({key='titles.json',flipDuringGuard=false,writableStart=true,unreadable=false}){
 let writable=writableStart;
 const puts=[];
 const env={
  epgStep:true,
  BUCKET:{put:async(name,text)=>{puts.push({name,text});return {etag:'e'};}},
 };
 const context=vm.createContext({
  env,puts,
  CanonicalCatalogReader:{
   canonicalMirrorsWritable:async()=>{if(unreadable)throw Object.assign(new Error('held'),{code:'film_person_held'});return writable;},
  },
  EpgOrchestration:{assertStep:async()=>{if(flipDuringGuard)writable=false;}},
  JSON,undefined,
 });
 vm.runInContext(freeze+'\n'+save+'\nthis.saveJSON=saveJSON;',context);
 const result=await vm.runInContext('saveJSON(env,'+JSON.stringify(key)+',{ok:true})',context);
 return {result,puts,writable};
}

{
 const ok=await runSave({});
 assert.equal(ok.puts.length,1);
 assert.equal(ok.puts[0].name,'titles.json');
}
{
 const flipped=await runSave({flipDuringGuard:true});
 assert.equal(flipped.puts.length,0,'prepared→open during epgStepGuard must not put titles.json');
 assert.equal(flipped.result.skipped,'canonical_mirror_frozen');
}
{
 const people=await runSave({key:'people.json',flipDuringGuard:true});
 assert.equal(people.puts.length,0,'prepared→open during epgStepGuard must not put people.json');
}
{
 const held=await runSave({writableStart:false});
 assert.equal(held.puts.length,0,'held/open lock skips the put');
}
{
 const unread=await runSave({unreadable:true});
 assert.equal(unread.puts.length,0,'unreadable marker skips the put');
}
{
 const other=await runSave({key:'sync.json',flipDuringGuard:true});
 assert.equal(other.puts.length,1,'non-mirror keys still put after the guard');
}

console.log('canonical-mirror-put: saveJSON re-reads the Film/Person freeze at BUCKET.put after epgStepGuard; titles.json and people.json are not written after a flip, held or unreadable marker');
