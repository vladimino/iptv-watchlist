// AIR-374 S4-2: the offline 0020 preflight kit (scripts/film-person-0020-preflight.mjs). It runs the EMITTED statements on the real migration chain over the sqlite3 CLI stand-in (a schema-19 copy before the apply, the same copy after
// the checked-in file), and checks that the verifier passes exactly that state and refuses every named deviation. PREFLIGHT_MODULE points the file at a mutant copy (tests/film-person-0020-preflight-mutation.mjs).
// No R2, no D1, no Cloudflare, no network: nothing here applies a migration to production.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqliteSync} from './sqlite-session.mjs';

const target=process.env.PREFLIGHT_MODULE?pathToFileURL(path.resolve(process.env.PREFLIGHT_MODULE)).href:new URL('../scripts/film-person-0020-preflight.mjs',import.meta.url).href;
const K=await import(target);
const FILE='migrations/0020_canonical_producer_run.sql';
const text=fs.readFileSync(FILE,'utf8');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-0020-preflight-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const run=(file,input,json)=>{const r=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input+(json?';':''),encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return json?(o?JSON.parse(o):[]):o;};
const MARKER='prepared/open/1';

// ---------- identity: recomputed from the file, equal to git and to the runbook ----------
const id=K.identityOf(text);
assert.equal(id.gitBlob,execFileSync('git',['hash-object',FILE],{encoding:'utf8'}).trim());
assert.equal(id.sha256,execFileSync('sha256sum',[FILE],{encoding:'utf8'}).split(' ')[0]);
assert.equal(id.bytes,fs.statSync(FILE).size);
assert.equal(id.statements,34);
assert.equal(K.identityOf('é').bytes,2,'bytes, not characters');
assert.deepEqual(id.expectedApplyResults,{statements:34,firstChanges:0,lastChanges:1,allSuccess:true});
assert.notEqual(K.identityOf(text+'\n').sha256,id.sha256,'one extra byte changes the digest');
assert.notEqual(K.identityOf(text+'\n').gitBlob,id.gitBlob);
assert.equal(K.identityOf(text+'\n').bytes,id.bytes+1);
assert.equal(K.identityOf(text+'\n').statementsSha256,id.statementsSha256,'a trailing newline is not a statement');
assert.equal(K.identityOf(text.replace('CREATE INDEX canonical_producer_run_fresh','-- x\nCREATE INDEX canonical_producer_run_fresh')).statements,34,'a comment line is not a statement');
assert.equal(K.identityOf(text.replace('CREATE INDEX canonical_producer_run_fresh','-- x\nCREATE INDEX canonical_producer_run_fresh')).statementsSha256,id.statementsSha256,'a comment does not move the statements digest');
assert.equal(K.identityOf(text.replace('UPDATE schema_contract','UPDATE schema_contract;\nUPDATE schema_contract')).statements,35);
assert.notEqual(K.identityOf(text.replace('WHERE id = 1 AND version = 19;','WHERE id = 1 AND version = 18;')).statementsSha256,id.statementsSha256,'a changed statement moves the statements digest');
assert.equal(K.statementsOf(text).length,34);
{
 const stripped=text.split('\n').filter(line=>!/^\s*--/.test(line)&&line.trim()!=='').join('\n').replace(/;$/,'');
 assert.equal(id.statementsSha256,execFileSync('sha256sum',{input:stripped,encoding:'utf8'}).split(' ')[0],'the statements digest is the digest of the file without its comments and blank lines (and its last semicolon)');
}
assert.ok(K.statementsOf(text).every(statement=>!statement.endsWith(';')&&/^(INSERT|CREATE|UPDATE)\b/.test(statement)));
{
 const runbook=fs.readFileSync('docs/runbooks/film-person-0020-apply.md','utf8');
 for(const value of [id.gitBlob,id.sha256,id.statementsSha256,id.bytes.toLocaleString('en-US')])assert.ok(runbook.includes(value),'the runbook names the identity of the file: '+value);
}
// the file shape the plan relies on
assert.equal(K.prerequisiteTables(text).length,6);
const rec=K.expectedFromFile(text);
assert.deepEqual([rec.tables.length,rec.indexes.length,rec.triggers.length],[2,7,22]);
assert.deepEqual([...rec.tables].sort(),[...K.PRODUCER_TABLES].sort());
assert.ok(!rec.triggers.includes(K.SHARED_TRIGGER));
assert.ok(text.includes(K.NOTE));
assert.equal(Object.keys(K.definitionsOf(text)).length,2+7+22);
assert.ok(Object.keys(K.definitionsOf(text)).every(name=>name.startsWith('canonical_producer_')),'every object of the file carries the pattern the foreign-object statement searches');

// ---------- the emitted statements: every one a single read-only SELECT, and each runs on the real chain ----------
const pre=K.preflightSteps(text),post=K.readbackSteps(text);
for(const item of [...pre,...post]){assert.match(item.sql,/^SELECT\b/);assert.ok(!item.sql.includes(';'));assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH)\b/i.test(item.sql),item.id);}
assert.deepEqual(pre.map(item=>item.id),['schema','prerequisites','existing_producer_objects','shared_trigger','unchanged_rows','marker','fence','baseline','projector_lease','projector_window','discovery_lease']);
assert.deepEqual(post.map(item=>item.id),['schema','objects','definitions','foreign_objects','producer_rows','unchanged_rows','marker','fence','baseline','projector_lease','projector_window','discovery_lease']);
assert.equal(K.MANUAL_STEPS.length,4);
assert.equal(pre.find(item=>item.id==='existing_producer_objects').sql,"SELECT type, name FROM sqlite_master WHERE name GLOB 'canonical_producer_*' ORDER BY type, name");
assert.ok(post.find(item=>item.id==='objects').sql.includes("'schema_contract_no_downgrade'"));
assert.ok(!post.find(item=>item.id==='definitions').sql.includes("'schema_contract_no_downgrade'"),'the shared trigger predates the file: its text is not compared');
assert.throws(()=>K.preflightSteps(text.replace("'film_person_cas',\n","'film_person_cas; DROP TABLE x',\n")),/unexpected object name/);
assert.throws(()=>K.prerequisiteTables(text.replace("'film_person_cas',\n","'film_person_cas; DROP TABLE x',\n")),/unexpected object name in the prerequisite/);
assert.throws(()=>K.readbackSteps(text+'\nCREATE TABLE Bad_Name (x INTEGER);'),/unexpected object name Bad_Name/);
assert.throws(()=>K.step('x','y','DROP TABLE a',''),/read-only SELECT/);
assert.throws(()=>K.step('x','y','SELECT 1; DROP TABLE a',''),/read-only SELECT/);
assert.throws(()=>K.prerequisiteTables(text.replace("   'film_person_cas',\n","")),/six tables, found 5/);

const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const v19=path.join(root,'v19.sqlite');
run(v19,chain.filter(name=>Number(name.slice(0,4))<=19).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+
 "\nUPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;");
const collect=(file,steps)=>Object.fromEntries(steps.map(item=>[item.id,run(file,item.sql,true)]));
const clone=value=>JSON.parse(JSON.stringify(value));
const NOW='2026-11-12T12:00:00.000Z';

const before=collect(v19,pre);
assert.equal(before.schema[0].version,19);
assert.deepEqual(before.marker,[{mode:'prepared',cutover:'open',generation:1}]);
assert.deepEqual(K.verifyPreflight(before,{text,now:NOW,expectMarker:MARKER}),{ok:true,refusals:[],notes:['manual rows still to record: 1, 11, 12, 13']});
assert.deepEqual(K.verifyPreflight(before,{text,now:NOW,expectMarker:'d1/open/2'}).refusals,['marker_moved:prepared/open/1']);
// a D1 envelope is accepted as well as plain rows; a failed envelope is a refusal, not an empty result
const envelope=Object.fromEntries(Object.entries(before).map(([key,rows])=>[key,[{success:true,results:rows}]]));
assert.equal(K.verifyPreflight(envelope,{text,now:NOW,expectMarker:MARKER}).ok,true);
assert.deepEqual(K.verifyPreflight({...envelope,schema:[{success:false,results:[]}]},{text,now:NOW,expectMarker:MARKER}).refusals,['result_failed:schema']);
assert.deepEqual(K.verifyPreflight({...envelope,schema:[{success:true}]},{text,now:NOW,expectMarker:MARKER}).refusals,['result_failed:schema']);

const pf=(patch,expectRefusal,opts={})=>{
 const results={...clone(before),...patch};
 const out=K.verifyPreflight(results,{text,now:NOW,expectMarker:MARKER,...opts});
 assert.equal(out.ok,false,JSON.stringify(patch));
 assert.deepEqual(out.refusals,[].concat(expectRefusal),JSON.stringify(patch));
};
for(const key of Object.keys(before)){const results=clone(before);delete results[key];assert.deepEqual(K.verifyPreflight(results,{text,now:NOW,expectMarker:MARKER}).refusals,['result_missing:'+key]);}
assert.deepEqual(K.verifyPreflight(null,{text,now:NOW,expectMarker:MARKER}).ok,false);
pf({schema:[{id:1,version:20,note:'x'}]},'schema_version:20');
pf({schema:[{id:1,version:18,note:'x'}]},'schema_version:18');
pf({schema:[{id:1,version:19,note:'x'},{id:2,version:19,note:'y'}]},'schema_contract_rows:2');
pf({schema:[]},'schema_contract_rows:0');
pf({schema:[{id:2,version:19,note:'x'}]},'schema_contract_id:2');
pf({prerequisites:before.prerequisites.slice(1)},'prerequisites_incomplete:1/6 missing');
pf({prerequisites:[]},'prerequisites_incomplete:6/6 missing');
pf({existing_producer_objects:[{type:'table',name:'canonical_producer_run'}]},'producer_objects_present:1');
pf({shared_trigger:[]},'shared_trigger_missing');
pf({marker:[{mode:'d1',cutover:'open',generation:2}]},'marker_moved:d1/open/2');
pf({marker:[{mode:'prepared',cutover:'held',generation:1}]},'marker_moved:prepared/held/1');
pf({marker:[{mode:'prepared',cutover:'open',generation:2}]},'marker_moved:prepared/open/2');
pf({marker:[]},'marker_rows:0');
pf({marker:[{mode:'prepared',cutover:'open',generation:1},{mode:'prepared',cutover:'open',generation:1}]},'marker_rows:2');
pf({marker:[{mode:'x',cutover:'open',generation:1}]},'marker_unreadable:x/open/1');
pf({marker:[{mode:'prepared',cutover:'open',generation:null}]},'marker_unreadable:prepared/open/null');
// the marker is judged against the GO, in any state: d1/open and d1/held pass when the GO names them
for(const [row,pin] of [[{mode:'d1',cutover:'open',generation:2},'d1/open/2'],[{mode:'d1',cutover:'held',generation:3},'d1/held/3'],[{mode:'r2',cutover:'open',generation:0},'r2/open/0']]){
 assert.equal(K.verifyPreflight({...clone(before),marker:[row]},{text,now:NOW,expectMarker:pin}).ok,true,pin);
}
pf({fence:[{ok:0}]},'fence_not_ok:0');
pf({fence:[]},'fence_rows:0');
pf({fence:[{ok:1},{ok:1}]},'fence_rows:2');
pf({baseline:[]},'baseline_rows:0');
pf({unchanged_rows:[]},'unchanged_rows_rows:0');
pf({unchanged_rows:[before.unchanged_rows[0],before.unchanged_rows[0]]},'unchanged_rows_rows:2');
pf({unchanged_rows:[{...before.unchanged_rows[0],canonical_revision:null}]},'count_unreadable:canonical_revision');
pf({unchanged_rows:[{...before.unchanged_rows[0],film_retention:-1}]},'count_unreadable:film_retention');
pf({projector_lease:[{lease_id:'a',lease_until:'2026-11-12T12:30:00.000Z'}]},'projector_lease_live');
pf({projector_lease:[{lease_id:'a',lease_until:null}]},'projector_lease_live');
pf({projector_lease:[{lease_id:'a',lease_until:'2026-11-12T11:00:00.000Z'},{lease_id:null,lease_until:null}]},'projector_lease_rows:2');
assert.equal(K.verifyPreflight({...clone(before),projector_lease:[{lease_id:'a',lease_until:'2026-11-12T11:00:00.000Z'}]},{text,now:NOW,expectMarker:MARKER}).ok,true,'an expired lease is free');
assert.equal(K.verifyPreflight({...clone(before),projector_lease:[]},{text,now:NOW,expectMarker:MARKER}).ok,true,'no run recorded is free');
pf({projector_window:[{state:'requested',expires_at:1}]},'projector_window_not_idle:requested');
pf({projector_window:[]},'projector_window_rows:0');
pf({discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)+1000}]},'discovery_lease_live');
assert.equal(K.verifyPreflight({...clone(before),discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)-1000}]},{text,now:NOW,expectMarker:MARKER}).ok,true);
assert.equal(K.verifyPreflight({...clone(before),discovery_lease:[{id:1,lease_id:null,expires_at:0}]},{text,now:NOW,expectMarker:MARKER}).ok,true);
// loaded tables are recorded, never a blocker (a later operation may have written them)
assert.equal(K.verifyPreflight({...clone(before),unchanged_rows:[{...before.unchanged_rows[0],canonical_write_receipt:5,film_rated_admission:708}]},{text,now:NOW,expectMarker:MARKER}).ok,true);
pf({schema:'rows'},'result_malformed:schema');
pf({marker:[['prepared']]},'result_malformed:marker');
const many=K.verifyPreflight({...clone(before),schema:[{id:1,version:20,note:'x'}],projector_window:[{state:'held',expires_at:1}]},{text,now:NOW,expectMarker:MARKER});
assert.deepEqual(many.refusals,['schema_version:20','projector_window_not_idle:held']);

// ---------- apply the checked-in file once to the copy, then read back ----------
const v20=path.join(root,'v20.sqlite');
fs.copyFileSync(v19,v20);
run(v20,text);
const after=collect(v20,post);
const RO={text,expectMarker:MARKER,preflight:before};
assert.equal(after.schema[0].version,20);
assert.equal(after.objects.length,2+7+22+1);
assert.equal(after.definitions.length,2+7+22,'the stored definitions of every object');
assert.equal(K.verifyReadback(after,RO).ok,true,JSON.stringify(K.verifyReadback(after,RO).refusals));
assert.deepEqual(K.verifyReadback(after,RO).refusals,[]);
assert.equal(K.verifyReadback(Object.fromEntries(Object.entries(after).map(([k,v])=>[k,[{success:true,results:v}]])),RO).ok,true);
// the stored text equals the statements of the file (sqlite_master keeps the CREATE text as written), so the digest of the statements is the digest of what ran
const wantDefs=K.definitionsOf(text);
for(const row of after.definitions)assert.equal(row.sql,wantDefs[row.name],row.name);
// the preflight of the applied database is refused: a second apply is never planned
assert.ok(K.verifyPreflight(collect(v20,pre),{text,now:NOW,expectMarker:MARKER}).refusals.includes('schema_version:20'));
assert.ok(K.verifyPreflight(collect(v20,pre),{text,now:NOW,expectMarker:MARKER}).refusals.some(item=>item.startsWith('producer_objects_present:')));
// and the readback of the un-applied database is refused (the row counts would be a SQL error before the apply: on D1 a failed envelope, here the step is simply not run)
const notYet=K.verifyReadback(collect(v19,post.filter(item=>item.id!=='producer_rows')),RO);
assert.equal(notYet.ok,false);assert.ok(notYet.refusals.includes('schema_version:19'));assert.ok(notYet.refusals.some(item=>item.startsWith('objects_missing:')));assert.ok(notYet.refusals.some(item=>item.startsWith('definitions_missing:')));

const rb=(patch,expectRefusal,opts={})=>{
 const out=K.verifyReadback({...clone(after),...patch},{...RO,...opts});
 assert.equal(out.ok,false,JSON.stringify(patch).slice(0,120));
 assert.deepEqual(out.refusals,[].concat(expectRefusal),JSON.stringify(patch).slice(0,120));
};
for(const key of Object.keys(after)){const results=clone(after);delete results[key];assert.deepEqual(K.verifyReadback(results,RO).refusals,['result_missing:'+key]);}
rb({schema:[{id:1,version:19,note:after.schema[0].note}]},'schema_version:19');
rb({schema:[{id:1,version:21,note:after.schema[0].note}]},'schema_version:21');
rb({schema:[{id:1,version:20,note:'other'}]},'schema_note_mismatch');
rb({schema:[after.schema[0],after.schema[0]]},'schema_contract_rows:2');
const drop=(type,name)=>after.objects.filter(row=>!(row.type===type&&row.name===name));
rb({objects:drop('table','canonical_producer_unit_result')},'objects_missing:table:canonical_producer_unit_result');
rb({objects:drop('index','canonical_producer_run_seq')},'objects_missing:index:canonical_producer_run_seq');
rb({objects:drop('trigger','canonical_producer_run_no_delete')},'objects_missing:trigger:canonical_producer_run_no_delete');
rb({objects:drop('trigger',K.SHARED_TRIGGER)},'objects_missing:trigger:'+K.SHARED_TRIGGER);
rb({objects:[...after.objects,{type:'trigger',name:'canonical_producer_extra'}]},'objects_unexpected:trigger:canonical_producer_extra');
rb({objects:after.objects.map(row=>row.name==='canonical_producer_run'?{type:'view',name:row.name}:row)},['objects_missing:table:canonical_producer_run','objects_unexpected:view:canonical_producer_run']);
// a stored definition that differs from the file (a different CHECK, a changed trigger) is named
const alter=(name,change)=>after.definitions.map(row=>row.name===name?{...row,sql:change(row.sql)}:row);
rb({definitions:alter('canonical_producer_run',sql=>sql.replace('BETWEEN 0 AND 2','BETWEEN 0 AND 3'))},'definition_mismatch:canonical_producer_run');
rb({definitions:alter('canonical_producer_unit_result_transition',sql=>sql.replace("'settled', ",''))},'definition_mismatch:canonical_producer_unit_result_transition');
rb({definitions:alter('canonical_producer_run_seq',sql=>sql+' ')},'definition_mismatch:canonical_producer_run_seq');
rb({definitions:after.definitions.filter(row=>row.name!=='canonical_producer_run_fresh')},'definitions_missing:1');
rb({definitions:after.definitions.map(row=>({...row,sql:row.sql.replace(/\n/g,'\r\n')}))},'definition_mismatch:'+Object.keys(wantDefs).filter(name=>wantDefs[name].includes('\n')).sort().join(','));
rb({foreign_objects:[{type:'table',name:'canonical_producer_shadow'}]},'objects_unexpected:table:canonical_producer_shadow');
for(const table of K.PRODUCER_TABLES)rb({producer_rows:[{...after.producer_rows[0],[table]:1}]},'count_not_expected:'+table+':1');
rb({producer_rows:[{canonical_producer_run:0}]},'count_unreadable:canonical_producer_unit_result');
rb({producer_rows:[]},'producer_rows_rows:0');
rb({producer_rows:[after.producer_rows[0],after.producer_rows[0]]},'producer_rows_rows:2');
rb({marker:[{mode:'d1',cutover:'open',generation:2}]},['marker_moved:d1/open/2','marker_changed']);
rb({fence:[{ok:0}]},['fence_not_ok:0','fence_changed']);
rb({schema:[{success:false}]},'result_failed:schema');
// the migration shape the readback relies on
assert.deepEqual(K.verifyReadback(after,{...RO,text:text.replace(/CREATE INDEX canonical_producer_run_updated[^\n]*\n/,'')}).refusals.filter(item=>item.startsWith('migration_shape')),['migration_shape:2/6/22']);

// ---------- fail closed: the pinned marker and the preflight bundle ----------
assert.deepEqual(K.verifyPreflight(before,{text,now:NOW}).refusals,['expected_marker_missing']);
assert.equal(K.verifyPreflight(before,{text,now:NOW,expectMarker:''}).ok,false);
assert.deepEqual(K.verifyPreflight(before,{text,now:NOW,expectMarker:'prepared/open'}).refusals,['expected_marker_invalid','marker_moved:prepared/open/1']);
assert.deepEqual(K.verifyReadback(after,{text,preflight:before}).refusals,['expected_marker_missing']);
assert.deepEqual(K.verifyReadback(after,{text,preflight:before,expectMarker:'x'}).refusals,['expected_marker_invalid','marker_moved:prepared/open/1','preflight_marker_mismatch']);
assert.deepEqual(K.verifyReadback(after,{text,expectMarker:MARKER}).refusals,['preflight_bundle_missing']);
assert.deepEqual(K.verifyReadback(after,{text,expectMarker:MARKER,preflight:[]}).refusals,['preflight_bundle_missing']);
// the shape-only diagnostic is named and never ok
for(const out of [K.verifyPreflight(before,{text,now:NOW,diagnostic:true}),K.verifyReadback(after,{text,diagnostic:true})]){
 assert.equal(out.ok,false);assert.equal(out.diagnosticOnly,true);assert.equal(out.shapeOk,true);assert.ok(out.notes.some(item=>item.startsWith('diagnostic only')));
}
assert.equal(K.verifyReadback({...clone(after),schema:[{id:1,version:19,note:'x'}]},{text,diagnostic:true}).shapeOk,false);
assert.equal(K.verifyPreflight(before,{text,now:NOW,diagnostic:true,expectMarker:MARKER}).ok,false,'a diagnostic with a pin is still not a GO pass');
// mismatches: pinned vs preflight vs readback
assert.deepEqual(K.verifyReadback(after,{...RO,expectMarker:'d1/open/2'}).refusals,['marker_moved:prepared/open/1','preflight_marker_mismatch']);
const bundle=patch=>({...clone(before),...patch});
assert.deepEqual(K.verifyReadback(after,{...RO,preflight:bundle({marker:[{mode:'d1',cutover:'open',generation:2}]})}).refusals,['preflight_marker_mismatch','marker_changed']);
// the preflight bundle itself
assert.deepEqual(K.verifyReadback(after,{...RO,preflight:bundle({schema:[{id:1,version:20,note:'x'}]})}).refusals,['preflight:preflight_not_version_19']);
{const b=bundle({});delete b.projector_lease;assert.deepEqual(K.verifyReadback(after,{...RO,preflight:b}).refusals,['preflight:result_missing:projector_lease']);}
{const b=bundle({});delete b.unchanged_rows;assert.deepEqual(K.verifyReadback(after,{...RO,preflight:b}).refusals,['preflight:result_missing:unchanged_rows']);}
// the unchanged facts of section 6, against the preflight: counts, marker, fence, baseline, the three leases
const same={...clone(after),projector_lease:[{lease_id:'a',lease_until:'2026-11-12T11:00:00.000Z'}]};
assert.equal(K.verifyReadback(same,{...RO,preflight:bundle({projector_lease:same.projector_lease})}).ok,true,'an unchanged expired lease row is unchanged');
assert.deepEqual(K.verifyReadback(same,RO).refusals,['projector_lease_changed']);
rb({projector_lease:[{lease_id:'b',lease_until:'2026-11-12T13:00:00.000Z'}]},'projector_lease_changed');
rb({projector_window:[{state:'requested',expires_at:5}]},'projector_window_changed');
rb({projector_window:[]},'projector_window_changed');
rb({discovery_lease:[{id:1,lease_id:'x',expires_at:99}]},'discovery_lease_changed');
rb({discovery_lease:[...after.discovery_lease,{id:2,lease_id:null,expires_at:0}]},'discovery_lease_changed');
rb({baseline:[{state:'verified',reference:'other'}]},'baseline_changed');
for(const table of K.UNCHANGED_TABLES)rb({unchanged_rows:[{...after.unchanged_rows[0],[table]:Number(after.unchanged_rows[0][table])+1}]},'unchanged_rows_changed');
// a loaded database is judged the same way: the counts are what the preflight saw
{
 const loaded=clone(before);loaded.unchanged_rows=[{...before.unchanged_rows[0],canonical_write_receipt:5,canonical_revision:708}];
 const loadedAfter={...clone(after),unchanged_rows:loaded.unchanged_rows};
 assert.equal(K.verifyReadback(loadedAfter,{...RO,preflight:loaded}).ok,true);
 assert.deepEqual(K.verifyReadback(after,{...RO,preflight:loaded}).refusals,['unchanged_rows_changed']);
}
// key order does not matter, values do
assert.equal(K.verifyReadback({...clone(after),projector_lease:[{lease_until:'2026-11-12T11:00:00.000Z',lease_id:'a'}]},{...RO,preflight:bundle({projector_lease:same.projector_lease})}).ok,true);
// an envelope-wrapped preflight bundle is read like plain rows
assert.equal(K.verifyReadback(after,{...RO,preflight:Object.fromEntries(Object.entries(before).map(([k,v])=>[k,[{success:true,results:v}]]))}).ok,true);
assert.ok(post.filter(item=>K.COMPARED.includes(item.id)).every(item=>pre.find(other=>other.id===item.id).sql===item.sql),'the compared readback statements are exactly the preflight statements');

// ---------- a second state of the world: the marker at d1/open/2 (after a canonical operation), pinned by the GO ----------
{
 const v19b=path.join(root,'v19b.sqlite');fs.copyFileSync(v19,v19b);run(v19b,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
 const b=collect(v19b,pre),pin='d1/open/2';
 assert.equal(K.verifyPreflight(b,{text,now:NOW,expectMarker:pin}).ok,true);
 assert.deepEqual(K.verifyPreflight(b,{text,now:NOW,expectMarker:MARKER}).refusals,['marker_moved:d1/open/2']);
 run(v19b,text);
 assert.equal(K.verifyReadback(collect(v19b,post),{text,expectMarker:pin,preflight:b}).ok,true);
}

// ---------- CLI: dry and offline ----------
const script=process.env.PREFLIGHT_MODULE||'scripts/film-person-0020-preflight.mjs';
const cli=(...args)=>{try{return {code:0,out:execFileSync(process.execPath,[script,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})};}catch(error){return {code:error.status,out:String(error.stdout)};}};
{
 assert.deepEqual(JSON.parse(cli('identity').out),id);
 assert.equal(JSON.parse(cli('preflight-sql').out).steps.length,11);
 assert.equal(JSON.parse(cli('readback-sql').out).steps.length,12);
 const good=path.join(root,'good.json'),bad=path.join(root,'bad.json');
 fs.writeFileSync(good,JSON.stringify(after));fs.writeFileSync(bad,JSON.stringify({...after,schema:[{id:1,version:19,note:'x'}]}));
 const preFile=path.join(root,'pre.json');fs.writeFileSync(preFile,JSON.stringify(before));
 const pinned=['--preflight',preFile,'--marker',MARKER];
 assert.equal(cli('verify-readback',good,...pinned).code,0);
 const refused=cli('verify-readback',bad,...pinned);
 assert.equal(refused.code,1);assert.deepEqual(JSON.parse(refused.out).refusals,['schema_version:19']);
 const open=cli('verify-readback',good);
 assert.equal(open.code,1);assert.deepEqual(JSON.parse(open.out).refusals,['expected_marker_missing','preflight_bundle_missing']);
 assert.equal(cli('verify-readback',good,'--diagnostic').code,1);assert.equal(JSON.parse(cli('verify-readback',good,'--diagnostic').out).diagnosticOnly,true);
 const preResults=path.join(root,'pre-results.json');fs.writeFileSync(preResults,JSON.stringify(before));
 assert.equal(cli('verify-preflight',preResults,'--now',NOW,'--marker',MARKER).code,0);
 assert.deepEqual(JSON.parse(cli('verify-preflight',preResults,'--now',NOW).out).refusals,['expected_marker_missing']);
 assert.equal(JSON.parse(cli('verify-preflight',preResults,'--now',NOW,'--diagnostic').out).diagnosticOnly,true);
 assert.equal(cli('nonsense').code,2);
}
console.log('film-person-0020-preflight: ok');
