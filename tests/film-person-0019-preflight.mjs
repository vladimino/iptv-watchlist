// AIR-374 H0: the offline 0019 preflight kit (scripts/film-person-0019-preflight.mjs). It runs the EMITTED statements on the real migration chain over the sqlite3 CLI stand-in
// (a prepared schema-18 copy before the apply, the same copy after the checked-in file), and checks that the verifier passes exactly that state and refuses every named deviation.
// PREFLIGHT_MODULE points the file at a mutant copy (tests/film-person-0019-preflight-mutation.mjs). No R2, no D1, no Cloudflare, no network.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqliteSync} from './sqlite-session.mjs';

const target=process.env.PREFLIGHT_MODULE?pathToFileURL(path.resolve(process.env.PREFLIGHT_MODULE)).href:new URL('../scripts/film-person-0019-preflight.mjs',import.meta.url).href;
const K=await import(target);
const text=fs.readFileSync('migrations/0019_canonical_write_receipt.sql','utf8');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-0019-preflight-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const run=(file,input,json)=>{const r=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input+(json?';':''),encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return json?(o?JSON.parse(o):[]):o;};
const REF='cutover_accepted/v2:'+'ab'.repeat(32);

// ---------- identity: recomputed from the file, equal to git and to the runbook ----------
const id=K.identityOf(text);
assert.equal(id.gitBlob,execFileSync('git',['hash-object','migrations/0019_canonical_write_receipt.sql'],{encoding:'utf8'}).trim());
assert.equal(id.sha256,execFileSync('sha256sum',['migrations/0019_canonical_write_receipt.sql'],{encoding:'utf8'}).split(' ')[0]);
assert.equal(id.bytes,fs.statSync('migrations/0019_canonical_write_receipt.sql').size);
assert.equal(id.statements,28);
assert.equal(K.identityOf('\u00e9').bytes,2,'bytes, not characters');
assert.deepEqual(id.expectedApplyResults,{statements:28,firstChanges:0,lastChanges:1,allSuccess:true});
assert.notEqual(K.identityOf(text+'\n').sha256,id.sha256,'one extra byte changes the digest');
assert.notEqual(K.identityOf(text+'\n').gitBlob,id.gitBlob);
assert.equal(K.identityOf(text+'\n').bytes,id.bytes+1);
assert.equal(K.identityOf(text.replace('CREATE INDEX canonical_write_receipt_due','-- x\nCREATE INDEX canonical_write_receipt_due')).statements,28,'a comment line is not a statement');
assert.equal(K.identityOf(text.replace('UPDATE schema_contract','UPDATE schema_contract;\nUPDATE schema_contract')).statements,29);
// the file shape the plan relies on
assert.equal(K.prerequisiteTables(text).length,8);
const rec=K.expectedFromFile(text);
assert.deepEqual([rec.tables.length,rec.indexes.length,rec.triggers.length],[4,2,19]);
assert.deepEqual([...rec.tables].sort(),[...K.RECEIPT_TABLES].sort());
assert.ok(!rec.triggers.includes(K.SHARED_TRIGGER));
assert.ok(text.includes(K.NOTE));

// ---------- the emitted statements: every one a single read-only SELECT, and each runs on the real chain ----------
const pre=K.preflightSteps(text),post=K.readbackSteps(text);
for(const item of [...pre,...post]){assert.match(item.sql,/^SELECT\b/);assert.ok(!item.sql.includes(';'));assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH)\b/i.test(item.sql),item.id);}
assert.deepEqual(pre.map(item=>item.id),['schema','prerequisites','existing_receipt_objects','shared_trigger','canonical_revision','marker','fence','baseline','projector_lease','projector_window','discovery_lease']);
assert.deepEqual(post.map(item=>item.id),['schema','objects','foreign_objects','receipt_rows','unchanged_rows','marker','fence','baseline']);
assert.equal(K.MANUAL_STEPS.length,4);
assert.equal(pre.find(item=>item.id==='existing_receipt_objects').sql,"SELECT type, name FROM sqlite_master WHERE name GLOB 'canonical_*receipt*' ORDER BY type, name");
assert.ok(post.find(item=>item.id==='objects').sql.includes("'schema_contract_no_downgrade'"));
assert.throws(()=>K.preflightSteps(text.replace("'projector_window'\n","'projector_window; DROP TABLE x'\n")),/unexpected object name/);
assert.throws(()=>K.prerequisiteTables(text.replace("'projector_window'\n","'projector_window; DROP TABLE x'\n")),/unexpected object name in the prerequisite/);
assert.throws(()=>K.readbackSteps(text+'\nCREATE TABLE Bad_Name (x INTEGER);'),/unexpected object name Bad_Name/);
assert.throws(()=>K.step('x','y','DROP TABLE a',''),/read-only SELECT/);
assert.throws(()=>K.step('x','y','SELECT 1; DROP TABLE a',''),/read-only SELECT/);
assert.throws(()=>K.prerequisiteTables(text.replace(",\n   'projector_window'\n",'\n')),/eight tables, found 7/);

const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const v18=path.join(root,'v18.sqlite');
run(v18,chain.filter(name=>Number(name.slice(0,4))<=18).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+
 `\nUPDATE film_person_baseline SET state='loading',reference='${REF}' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;`);
const collect=(file,steps)=>Object.fromEntries(steps.map(item=>[item.id,run(file,item.sql,true)]));
const clone=value=>JSON.parse(JSON.stringify(value));
const NOW='2026-11-12T12:00:00.000Z';

const before=collect(v18,pre);
assert.equal(before.schema[0].version,18);
assert.deepEqual(K.verifyPreflight(before,{text,now:NOW}),{ok:true,refusals:[],notes:['manual rows still to record: 1, 11, 12, 13']});
assert.equal(K.verifyPreflight(before,{text,now:NOW,expectReference:REF}).ok,true);
assert.deepEqual(K.verifyPreflight(before,{text,now:NOW,expectReference:'cutover_accepted/v2:'+'cd'.repeat(32)}).refusals,['baseline_reference_mismatch']);
// a D1 envelope is accepted as well as plain rows; a failed envelope is a refusal, not an empty result
const envelope=Object.fromEntries(Object.entries(before).map(([key,rows])=>[key,[{success:true,results:rows}]]));
assert.equal(K.verifyPreflight(envelope,{text,now:NOW}).ok,true);
assert.deepEqual(K.verifyPreflight({...envelope,schema:[{success:false,results:[]}]},{text,now:NOW}).refusals,['result_failed:schema']);
assert.deepEqual(K.verifyPreflight({...envelope,schema:[{success:true}]},{text,now:NOW}).refusals,['result_failed:schema']);

const pf=(patch,expectRefusal,opts={})=>{
 const results={...clone(before),...patch};
 const out=K.verifyPreflight(results,{text,now:NOW,...opts});
 assert.equal(out.ok,false,JSON.stringify(patch));
 assert.deepEqual(out.refusals,[].concat(expectRefusal),JSON.stringify(patch));
};
for(const key of Object.keys(before)){const results=clone(before);delete results[key];assert.deepEqual(K.verifyPreflight(results,{text,now:NOW}).refusals,['result_missing:'+key]);}
assert.deepEqual(K.verifyPreflight(null,{text,now:NOW}).ok,false);
pf({schema:[{id:1,version:19,note:'x'}]},'schema_version:19');
pf({schema:[{id:1,version:17,note:'x'}]},'schema_version:17');
pf({schema:[{id:1,version:18,note:'x'},{id:2,version:18,note:'y'}]},'schema_contract_rows:2');
pf({schema:[]},'schema_contract_rows:0');
pf({schema:[{id:2,version:18,note:'x'}]},'schema_contract_id:2');
pf({prerequisites:before.prerequisites.slice(1)},'prerequisites_incomplete:1/8 missing');
pf({prerequisites:[]},'prerequisites_incomplete:8/8 missing');
pf({existing_receipt_objects:[{type:'table',name:'canonical_write_receipt'}]},'receipt_objects_present:1');
pf({shared_trigger:[]},'shared_trigger_missing');
pf({marker:[{mode:'d1',cutover:'open',generation:2}]},'marker_moved:d1/open/2');
pf({marker:[{mode:'prepared',cutover:'held',generation:1}]},'marker_moved:prepared/held/1');
pf({marker:[{mode:'prepared',cutover:'open',generation:2}]},'marker_moved:prepared/open/2');
pf({marker:[]},'marker_rows:0');
pf({marker:[{mode:'r2',cutover:'open',generation:1}]},'marker_moved:r2/open/1');
pf({marker:[{mode:'prepared',cutover:'open',generation:1},{mode:'prepared',cutover:'open',generation:1}]},'marker_rows:2');
pf({fence:[{ok:0}]},'fence_not_ok:0');
pf({baseline:[{state:'empty',reference:null}]},'baseline_not_verified:empty');
pf({baseline:[{state:'verified',reference:'t'}]},'baseline_reference_shape');
pf({baseline:[{state:'verified',reference:null}]},'baseline_reference_shape');
pf({baseline:[{state:'verified',reference:'cutover_accepted/v2:abc'}]},'baseline_reference_shape');
pf({projector_lease:[{lease_id:'a',lease_until:'2026-11-12T12:30:00.000Z'}]},'projector_lease_live');
pf({projector_lease:[{lease_id:'a',lease_until:null}]},'projector_lease_live');
pf({projector_lease:[{lease_id:'a',lease_until:'2026-11-12T11:00:00.000Z'},{lease_id:null,lease_until:null}]},'projector_lease_rows:2');
assert.equal(K.verifyPreflight({...clone(before),projector_lease:[{lease_id:'a',lease_until:'2026-11-12T11:00:00.000Z'}]},{text,now:NOW}).ok,true,'an expired lease is free');
assert.equal(K.verifyPreflight({...clone(before),projector_lease:[]},{text,now:NOW}).ok,true,'no run recorded is free');
pf({projector_window:[{state:'requested',expires_at:1}]},'projector_window_not_idle:requested');
pf({projector_window:[]},'projector_window_rows:0');
pf({discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)+1000}]},'discovery_lease_live');
assert.equal(K.verifyPreflight({...clone(before),discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)-1000}]},{text,now:NOW}).ok,true);
assert.equal(K.verifyPreflight({...clone(before),discovery_lease:[{id:1,lease_id:null,expires_at:0}]},{text,now:NOW}).ok,true);
// a non-empty canonical_revision is reported, not a blocker
const noted=K.verifyPreflight({...clone(before),canonical_revision:[{n:3,m:7}]},{text,now:NOW});
assert.equal(noted.ok,true);assert.ok(noted.notes.some(item=>item.startsWith('canonical_revision_not_empty:3')));
pf({canonical_revision:[]},'canonical_revision_unreadable');
pf({schema:'rows'},'result_malformed:schema');
pf({marker:[['prepared']]},'result_malformed:marker');
// several deviations are all named
const many=K.verifyPreflight({...clone(before),schema:[{id:1,version:19,note:'x'}],projector_window:[{state:'held',expires_at:1}]},{text,now:NOW});
assert.deepEqual(many.refusals,['schema_version:19','projector_window_not_idle:held']);

// ---------- apply the checked-in file once to the copy, then read back ----------
const v19=path.join(root,'v19.sqlite');
fs.copyFileSync(v18,v19);
run(v19,text);
const after=collect(v19,post);
assert.equal(after.schema[0].version,19);
assert.equal(after.objects.length,4+2+19+1);
assert.deepEqual(K.verifyReadback(after,{text}),{ok:true,refusals:[],notes:[]});
assert.equal(K.verifyReadback(after,{text,expectReference:REF}).ok,true);
assert.equal(K.verifyReadback(Object.fromEntries(Object.entries(after).map(([k,v])=>[k,[{success:true,results:v}]])),{text}).ok,true);
// the preflight of the applied database is refused: a second apply is never planned
assert.ok(K.verifyPreflight(collect(v19,pre),{text,now:NOW}).refusals.includes('schema_version:19'));
assert.ok(K.verifyPreflight(collect(v19,pre),{text,now:NOW}).refusals.some(item=>item.startsWith('receipt_objects_present:')));
// and the readback of the un-applied database is refused
// (the receipt row counts would be a SQL error before the apply: on D1 that is a failed envelope, here the step is simply not run)
const notYet=K.verifyReadback(collect(v18,post.filter(item=>item.id!=='receipt_rows')),{text});
assert.equal(notYet.ok,false);assert.ok(notYet.refusals.includes('schema_version:18'));assert.ok(notYet.refusals.some(item=>item.startsWith('objects_missing:')));

const rb=(patch,expectRefusal,opts={})=>{
 const out=K.verifyReadback({...clone(after),...patch},{text,...opts});
 assert.equal(out.ok,false,JSON.stringify(patch).slice(0,120));
 assert.deepEqual(out.refusals,[].concat(expectRefusal),JSON.stringify(patch).slice(0,120));
};
for(const key of Object.keys(after)){const results=clone(after);delete results[key];assert.deepEqual(K.verifyReadback(results,{text}).refusals,['result_missing:'+key]);}
rb({schema:[{id:1,version:18,note:after.schema[0].note}]},'schema_version:18');
rb({schema:[{id:1,version:20,note:after.schema[0].note}]},'schema_version:20');
rb({schema:[{id:1,version:19,note:'other'}]},'schema_note_mismatch');
rb({schema:[after.schema[0],after.schema[0]]},'schema_contract_rows:2');
const drop=(type,name)=>after.objects.filter(row=>!(row.type===type&&row.name===name));
rb({objects:drop('table','canonical_receipt_watermark')},'objects_missing:table:canonical_receipt_watermark');
rb({objects:drop('index','canonical_write_receipt_due')},'objects_missing:index:canonical_write_receipt_due');
rb({objects:drop('trigger','canonical_receipt_baseline_no_delete')},'objects_missing:trigger:canonical_receipt_baseline_no_delete');
rb({objects:drop('trigger',K.SHARED_TRIGGER)},'objects_missing:trigger:'+K.SHARED_TRIGGER);
rb({objects:[...after.objects,{type:'trigger',name:'canonical_receipt_extra'}]},'objects_unexpected:trigger:canonical_receipt_extra');
rb({objects:after.objects.map(row=>row.name==='canonical_write_receipt'?{type:'view',name:row.name}:row)},['objects_missing:table:canonical_write_receipt','objects_unexpected:view:canonical_write_receipt']);
rb({foreign_objects:[{type:'table',name:'canonical_receipt_shadow'}]},'objects_unexpected:table:canonical_receipt_shadow');
for(const table of K.RECEIPT_TABLES)rb({receipt_rows:[{...after.receipt_rows[0],[table]:1}]},'count_not_expected:'+table+':1');
for(const table of K.H1_TABLES)rb({unchanged_rows:[{...after.unchanged_rows[0],[table]:2}]},'count_not_expected:'+table+':2');
assert.equal(K.verifyReadback({...clone(after),unchanged_rows:[{...after.unchanged_rows[0],film_rated_admission:708}]},{text,expectedCounts:{film_rated_admission:708}}).ok,true,'a later H1 load is stated, never assumed');
rb({receipt_rows:[{canonical_write_receipt:0}]},['count_unreadable:canonical_receipt_baseline','count_unreadable:canonical_receipt_watermark','count_unreadable:canonical_receipt_baseline_seal']);
rb({receipt_rows:[]},'receipt_rows_rows:0');
rb({marker:[{mode:'d1',cutover:'open',generation:2}]},'marker_moved:d1/open/2');
rb({marker:[{mode:'r2',cutover:'open',generation:0}]},'marker_moved:r2/open/0');
rb({fence:[{ok:0}]},'fence_not_ok:0');
rb({baseline:[{state:'loading',reference:REF}]},'baseline_not_verified:loading');
rb({baseline:[{state:'verified',reference:'cutover_accepted/v1:'+'ab'.repeat(32)}]},'baseline_reference_shape');
rb({baseline:[{state:'verified',reference:'cutover_accepted/v2:'+'cd'.repeat(32)}]},'baseline_reference_mismatch',{expectReference:REF});
rb({schema:[{success:false}]},'result_failed:schema');
// the apply identity in the readback plan is the same text: a mutated migration shape is refused by name
assert.deepEqual(K.verifyReadback(after,{text:text.replace(/CREATE INDEX canonical_write_receipt_target[^\n]*\n/,'')}).refusals.filter(item=>item.startsWith('migration_shape')),['migration_shape:4/1/19']);

// ---------- CLI: dry and offline ----------
const script=process.env.PREFLIGHT_MODULE||'scripts/film-person-0019-preflight.mjs';
const cli=(...args)=>{try{return {code:0,out:execFileSync(process.execPath,[script,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})};}catch(error){return {code:error.status,out:String(error.stdout)};}};
{
 assert.deepEqual(JSON.parse(cli('identity').out),id);
 assert.equal(JSON.parse(cli('preflight-sql').out).steps.length,11);
 assert.equal(JSON.parse(cli('readback-sql').out).steps.length,8);
 const good=path.join(root,'good.json'),bad=path.join(root,'bad.json');
 fs.writeFileSync(good,JSON.stringify(after));fs.writeFileSync(bad,JSON.stringify({...after,schema:[{id:1,version:18,note:'x'}]}));
 assert.equal(cli('verify-readback',good).code,0);
 const refused=cli('verify-readback',bad);
 assert.equal(refused.code,1);assert.deepEqual(JSON.parse(refused.out).refusals,['schema_version:18']);
 assert.equal(cli('nonsense').code,2);
}
console.log('film-person-0019-preflight: ok');
