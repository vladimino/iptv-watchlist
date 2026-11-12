// AIR-374 (offline, pure): classifyBlockers groups the handoffReadiness blocker strings by the work that clears them. No database, no template: the expected strings are built from the
// real registries exactly as tests/canonical-handoff-readiness.mjs builds them. A built-in mutation check runs the same assertions against mutants of the module and demands each is killed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {P6_DIFFERENTIAL_EXCEPTIONS} from '../src/canonical-film-writers.js';
import {EXTRA_EXCEPTIONS} from '../src/canonical-differential-registry.js';
import {PRODUCER_WIRING,EMPTY_CLASSES} from '../src/canonical-producers.js';
import {CANONICAL_READER_REGISTRY} from '../src/canonical-catalog-reader.js';

const target=path.resolve('src/canonical-readiness-classes.js');
const expectedBlockers=()=>[
 ...[...P6_DIFFERENTIAL_EXCEPTIONS,...EXTRA_EXCEPTIONS].filter(item=>item.status!=='accepted').map(item=>'exception_not_accepted:'+item.id),
 'receipts_protocol_unregistered',
 ...PRODUCER_WIRING.map(item=>'producer_not_wired:'+item.name),
 ...CANONICAL_READER_REGISTRY.filter(item=>item.class==='freeze'&&!item.moved).map(item=>'reader_not_moved:'+item.name),
 ...EMPTY_CLASSES.map(item=>'empty_class_not_loaded:'+item.name+':0/'+item.expected),
];
function check(mod){
 const list=expectedBlockers();
 const frozen=Object.freeze([...list]);
 const out=mod.classifyBlockers({ready:false,blockers:frozen});
 assert.equal(out.total,list.length);
 // Every blocker of the repository's own modelled state is classified and lands in exactly one class.
 assert.deepEqual(out.byClass.unclassified,[]);
 assert.equal(Object.values(out.byClass).reduce((sum,item)=>sum+item.length,0),list.length);
 assert.deepEqual(out.counts,{registry_code:5,data_load:3,owner_exception:list.filter(item=>item.startsWith('exception_not_accepted:')).length,read_move:list.filter(item=>item.startsWith('reader_not_moved:')).length,operational_state:0,unclassified:0});
 assert.deepEqual(out.byClass.registry_code,['receipts_protocol_unregistered',...PRODUCER_WIRING.map(item=>'producer_not_wired:'+item.name)]);
 assert.ok(out.byClass.owner_exception.every(item=>item.startsWith('exception_not_accepted:')));
 assert.ok(out.byClass.read_move.every(item=>item.startsWith('reader_not_moved:')));
 assert.ok(out.byClass.data_load.every(item=>item.startsWith('empty_class_not_loaded:')));
 // The order inside a class is the order of the input, and an array input works like a readiness object.
 assert.deepEqual(mod.classifyBlockers(list).byClass,out.byClass);
 // Every other blocker kind of handoffReadiness is operational state, and an unknown kind is never dropped.
 for(const item of ['marker_not_prepared:open','baseline_not_verified:null','receipts_baseline_missing','receipts_schema_missing','projector_lease_live','projector_window_not_idle:held','unreceipted_changes','schema_below_16:15','no_database'])assert.equal(mod.classOfBlocker(item),'operational_state',item);
 // The blocker strings below are the ones tests/canonical-handoff-readiness.mjs asserts handoffReadiness emits for its error and invalid-reader fixtures.
 for(const item of ['empty_class_unreadable:retirement','empty_class_unreadable:retention'])assert.equal(mod.classOfBlocker(item),'operational_state',item);
 for(const item of ['reader_class_invalid:x','reader_exception_marked_moved:some_reader'])assert.equal(mod.classOfBlocker(item),'registry_code',item);
 assert.equal(mod.classOfBlocker('empty_class_not_loaded:retention:0/401'),'data_load');
 assert.equal(mod.classOfBlocker('empty_class_not_loaded:retention:500/401'),'data_load');
 assert.equal(mod.classOfBlocker('reader_not_moved:x'),'read_move');
 {const mixed=mod.classifyBlockers(['empty_class_unreadable:a','empty_class_not_loaded:b:0/1','reader_class_invalid:c','reader_exception_marked_moved:d','reader_not_moved:e']);
  assert.deepEqual(mixed.byClass,{registry_code:['reader_class_invalid:c','reader_exception_marked_moved:d'],data_load:['empty_class_not_loaded:b:0/1'],owner_exception:[],read_move:['reader_not_moved:e'],operational_state:['empty_class_unreadable:a'],unclassified:[]});}
 assert.equal(mod.classOfBlocker('gap:film_sync_state clocks'),'registry_code');
 assert.equal(mod.classOfBlocker('brand_new_blocker:x'),'unclassified');
 assert.equal(mod.classOfBlocker('toString'),'unclassified');
 assert.deepEqual(mod.classifyBlockers(null),{total:0,counts:{registry_code:0,data_load:0,owner_exception:0,read_move:0,operational_state:0,unclassified:0},byClass:{registry_code:[],data_load:[],owner_exception:[],read_move:[],operational_state:[],unclassified:[]}});
 // Pure: the input is not changed (it was frozen) and a second call gives the same answer.
 assert.deepEqual(mod.classifyBlockers(frozen),out);
}
if(process.env.READINESS_CLASSES_MUTANT){
 check(await import(pathToFileURL(process.env.READINESS_CLASSES_MUTANT).href));
}else{
 check(await import(pathToFileURL(target).href));
 const source=fs.readFileSync(target,'utf8');
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'readiness-classes-'));
 const replacements=[
  ['producer_not_wired:\'registry_code\'','producer_not_wired:\'read_move\''],
  ['receipts_protocol_unregistered:\'registry_code\'','receipts_protocol_unregistered:\'operational_state\''],
  ['empty_class_not_loaded:\'data_load\'','empty_class_not_loaded:\'registry_code\''],
  ['exception_not_accepted:\'owner_exception\'','exception_not_accepted:\'data_load\''],
  ['empty_class_unreadable:\'operational_state\'','empty_class_unreadable:\'data_load\''],
  ['reader_class_invalid:\'registry_code\'','reader_class_invalid:\'read_move\''],
  ['reader_exception_marked_moved:\'registry_code\'','reader_exception_marked_moved:\'read_move\''],
  ['reader_not_moved:\'read_move\'','reader_not_moved:\'owner_exception\''],
  ['receipts_baseline_missing:\'operational_state\'','receipts_baseline_missing:\'registry_code\''],
  ['Object.prototype.hasOwnProperty.call(RULES,prefix)?RULES[prefix]:\'unclassified\'','RULES[prefix]||\'registry_code\''],
  ['Object.prototype.hasOwnProperty.call(RULES,prefix)?RULES[prefix]:\'unclassified\'','RULES[prefix]'],
  ['at<0?text:text.slice(0,at)','text'],
  ['for(const blocker of list)byClass[classOfBlocker(blocker)].push(String(blocker));','for(const blocker of list)byClass[classOfBlocker(blocker)].unshift(String(blocker));'],
  ['for(const blocker of list)byClass[classOfBlocker(blocker)].push(String(blocker));','for(const blocker of list.slice(1))byClass[classOfBlocker(blocker)].push(String(blocker));'],
  ['const list=Array.isArray(readiness)?readiness:','const list=Array.isArray(readiness)?[]:'],
 ];
 let killed=0;
 for(const [at,[from,to]] of replacements.entries()){
  assert.ok(source.includes(from),'mutation site exists: '+from);
  const file=path.join(dir,'mutant-'+at+'.js');
  fs.writeFileSync(file,source.replace(from,to));
  const run=await import('node:child_process').then(({spawnSync})=>spawnSync(process.execPath,[new URL(import.meta.url).pathname],{env:{...process.env,READINESS_CLASSES_MUTANT:file},encoding:'utf8'}));
  if(run.status!==0)killed++;else assert.fail('mutant survived: '+from+' -> '+to);
 }
 assert.equal(killed,replacements.length);
 fs.rmSync(dir,{recursive:true,force:true});
}
console.log('canonical-readiness-classes ok');
