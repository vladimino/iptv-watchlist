// AIR-374 H1: the offline operator verifier of the P5 load (scripts/film-person-h1-verify.mjs). The emitted statements run on the real migration chain (0001 to 0019) over the sqlite3 CLI stand-in, and the
// verdicts are checked on result bundles built from that state and on in-memory fixtures. VERIFY_MODULE points the file at a mutant copy (tests/film-person-h1-verify-mutation.mjs).
// No R2, no D1, no Cloudflare, no network: nothing here sends or builds a write batch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqliteSync} from './sqlite-session.mjs';
import * as P from '../scripts/film-person-0019-preflight.mjs';
import * as L from '../scripts/film-person-prepared-loader.mjs';

const target=process.env.VERIFY_MODULE?pathToFileURL(path.resolve(process.env.VERIFY_MODULE)).href:new URL('../scripts/film-person-h1-verify.mjs',import.meta.url).href;
const K=await import(target);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-h1-verify-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const run=(file,input,json)=>{const r=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input+(json?';':''),encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return json?(o?JSON.parse(o):[]):o;};
const clone=value=>JSON.parse(JSON.stringify(value));
const REF='cutover_accepted/v2:'+'ab'.repeat(32);
const LEASE='h1-load:20261112T1000';
const NOW='2026-11-12T10:00:00.000Z';
const COUNTS=[708,401,4];
const hex=char=>char.repeat(64);

// ---------- the emitted statements ----------
const steps=K.stateSteps();
assert.deepEqual(steps.map(item=>item.id),['schema','marker','fence','baseline','projector_lease','projector_window','discovery_lease','receipt_tables','loader_tables','class_counts','other_counts']);
for(const item of steps){assert.match(item.sql,/^SELECT\b/);assert.ok(!item.sql.includes(';'));assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH|REPLACE)\b/i.test(item.sql),item.id);}
// the lease, window, Discovery lease, marker, fence, baseline and schema statements are the 0019 kit's own, character for character
const kit=P.preflightSteps();
for(const id of ['schema','marker','fence','baseline','projector_lease','projector_window','discovery_lease'])assert.equal(steps.find(item=>item.id===id).sql,kit.find(item=>item.id===id).sql,id);
assert.equal(steps.find(item=>item.id==='projector_lease').sql,"SELECT lease_id, lease_until FROM projection_run WHERE projection = 'enrichment'");
assert.equal(steps.find(item=>item.id==='projector_window').sql,'SELECT state, expires_at FROM projector_window WHERE id = 1');
assert.equal(steps.find(item=>item.id==='discovery_lease').sql,'SELECT id, lease_id, expires_at FROM discovery_lease');
assert.ok(steps.find(item=>item.id==='class_counts').sql.includes('FROM film_rated_admission')&&steps.find(item=>item.id==='class_counts').sql.includes('FROM film_retention')&&steps.find(item=>item.id==='class_counts').sql.includes('FROM tmdb_retirement_decision'));
assert.ok(steps.find(item=>item.id==='other_counts').sql.includes('canonical_write_receipt')&&steps.find(item=>item.id==='other_counts').sql.includes('FROM canonical_revision'));
assert.equal(K.MANUAL_STEPS.length,5);
assert.throws(()=>K.step('x','y','DROP TABLE a',''),/read-only SELECT/);
assert.throws(()=>K.step('x','y','SELECT 1; DROP TABLE a',''),/read-only SELECT/);
assert.equal(K.SCHEMA_VERSION,19);
assert.equal(K.MARKER_GENERATION,1);
assert.equal(K.MIN_LEASE_REMAINING_MS,15*60000);
assert.deepEqual(K.parseCounts('708,401,4'),[708,401,4]);
for(const bad of [null,undefined,'','708,401','708,401,4,1','a,b,c','708,-1,4','708,401,4 ','1234567,1,1'])assert.equal(K.parseCounts(bad),null,String(bad));

// ---------- the real chain: a schema 19 database at prepared, as production is expected to be before H1 ----------
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const db=path.join(root,'v19.sqlite');
run(db,chain.filter(name=>Number(name.slice(0,4))<=19).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+
 `\nUPDATE film_person_baseline SET state='loading',reference='${REF}' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;`);
const collect=file=>Object.fromEntries(steps.map(item=>[item.id,run(file,item.sql,true)]));
const real=collect(db);
assert.equal(real.schema[0].version,19);
assert.equal(real.receipt_tables.length,4);
assert.equal(real.loader_tables.length,5);
assert.deepEqual(real.class_counts,[{film_rated_admission:0,film_retention:0,tmdb_retirement_decision:0}]);
const out=K.verifyState('preflight',real,{expectReference:REF,now:NOW});
assert.deepEqual(out.refusals,[]);assert.equal(out.ok,true);
// a lease row (the shape the connector's acquire statement writes) held by the run, read back through the same statement
run(db,`INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','${LEASE}','2026-11-12T10:45:00.000Z','${NOW}')`);
const heldReal=collect(db);
assert.deepEqual(heldReal.projector_lease,[{lease_id:LEASE,lease_until:'2026-11-12T10:45:00.000Z'}]);
assert.deepEqual(K.verifyState('held',heldReal,{expectReference:REF,leaseId:LEASE,now:NOW}).refusals,[]);
assert.ok(K.verifyState('preflight',heldReal,{expectReference:REF,now:NOW}).refusals.includes('projector_lease_live'),'a lease taken is not the preflight state');
// the readback of a database that has not been loaded is refused: the counts are not the pinned ones
const unloaded=K.verifyState('readback',heldReal,{expectReference:REF,leaseId:LEASE,counts:COUNTS,now:NOW,held:heldReal});
assert.deepEqual(unloaded.refusals,COUNTS.map((n,i)=>'count_not_expected:'+L.TABLES[L.CLASSES[i]]+':0'));
// an envelope of the real rows is accepted as well as the plain rows
assert.equal(K.verifyState('held',Object.fromEntries(Object.entries(heldReal).map(([key,rows])=>[key,[{success:true,results:rows}]])),{expectReference:REF,leaseId:LEASE,now:NOW}).ok,true);

// ---------- in-memory fixtures for every phase ----------
const base=()=>({
 schema:[{id:1,version:19,note:P.NOTE}],
 marker:[{mode:'prepared',cutover:'open',generation:1}],
 fence:[{ok:1}],
 baseline:[{state:'verified',reference:REF}],
 projector_lease:[],
 projector_window:[{state:'idle',expires_at:null}],
 discovery_lease:[],
 receipt_tables:P.RECEIPT_TABLES.map(name=>({name})),
 loader_tables:['film_rated_admission','film_redirect','film_external_id','film_retention','tmdb_retirement_decision'].map(name=>({name})),
 class_counts:[{film_rated_admission:0,film_retention:0,tmdb_retirement_decision:0}],
 other_counts:[{film:100,person:50,film_external_id:300,film_redirect:2,canonical_revision:0,canonical_write_receipt:0,canonical_receipt_baseline:0,canonical_receipt_watermark:0,canonical_receipt_baseline_seal:0}],
});
const preflight=base();
const held={...base(),projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T10:45:00.000Z'}]};
const loaded=()=>({...clone(held),class_counts:[{film_rated_admission:708,film_retention:401,tmdb_retirement_decision:4}]});
const released=()=>({...base(),class_counts:[{film_rated_admission:708,film_retention:401,tmdb_retirement_decision:4}]});
const P1={expectReference:REF,now:NOW};
const H1={expectReference:REF,leaseId:LEASE,now:NOW};
const R1={...H1,counts:COUNTS,held};
assert.deepEqual(K.verifyState('preflight',preflight,P1),{ok:true,refusals:[],notes:['manual rows still to record: 5']});
assert.deepEqual(K.verifyState('held',held,H1),{ok:true,refusals:[],notes:['manual rows still to record: 5']});
assert.deepEqual(K.verifyState('readback',loaded(),R1).refusals,[]);
assert.equal(K.verifyState('readback',loaded(),R1).ok,true);
assert.deepEqual(K.verifyState('released',released(),R1).refusals,[]);
assert.equal(K.verifyState('released',released(),R1).ok,true);
assert.throws(()=>K.verifyState('apply',preflight,P1),/unknown phase/);
assert.equal(K.verifyState('readback',loaded(),{...R1,now:'2026-11-12T10:44:59.000Z'}).ok,true,'readback needs the lease live, not 15 minutes of it');
// a D1 envelope is accepted; a failed or empty envelope is a refusal, never an empty result
const envelope=bundle=>Object.fromEntries(Object.entries(bundle).map(([key,rows])=>[key,[{success:true,results:rows}]]));
assert.equal(K.verifyState('preflight',envelope(preflight),P1).ok,true);
assert.deepEqual(K.verifyState('preflight',{...envelope(preflight),schema:[{success:false,results:[]}]},P1).refusals,['result_failed:schema']);
assert.deepEqual(K.verifyState('preflight',{...envelope(preflight),schema:[{success:true}]},P1).refusals,['result_failed:schema']);

const check=(phase,bundle,opts,want)=>{
 const result=K.verifyState(phase,bundle,opts);
 assert.equal(result.ok,false,phase+JSON.stringify(want));
 assert.deepEqual(result.refusals,[].concat(want),phase);
 return result;
};
const pre=(patch,want,opts=P1)=>check('preflight',{...clone(preflight),...patch},opts,want);
const hld=(patch,want,opts=H1)=>check('held',{...clone(held),...patch},opts,want);
const rdb=(patch,want,opts=R1)=>check('readback',{...loaded(),...patch},opts,want);

// every result is required, in every phase
for(const key of Object.keys(preflight)){const bundle=clone(preflight);delete bundle[key];check('preflight',bundle,P1,'result_missing:'+key);}
for(const key of Object.keys(held)){const bundle=clone(held);delete bundle[key];check('held',bundle,H1,'result_missing:'+key);}
assert.equal(K.verifyState('preflight',null,P1).ok,false);
// schema
pre({schema:[{id:1,version:18,note:'x'}]},'schema_version:18');
pre({schema:[{id:1,version:20,note:'x'}]},'schema_version:20');
pre({schema:[{id:1,version:19,note:'other'}]},'schema_note_mismatch');
pre({schema:[{id:2,version:19,note:P.NOTE}]},'schema_contract_id:2');
pre({schema:[{id:1,version:19,note:P.NOTE},{id:2,version:19,note:P.NOTE}]},'schema_contract_rows:2');
pre({schema:[]},'schema_contract_rows:0');
// marker, fence, baseline
pre({marker:[{mode:'d1',cutover:'open',generation:2}]},'marker_moved:d1/open/2');
pre({marker:[{mode:'r2',cutover:'open',generation:0}]},'marker_moved:r2/open/0');
pre({marker:[{mode:'prepared',cutover:'held',generation:1}]},'marker_moved:prepared/held/1');
pre({marker:[{mode:'prepared',cutover:'open',generation:2}]},'marker_moved:prepared/open/2');
pre({marker:[]},'marker_rows:0');
pre({marker:[{mode:'prepared',cutover:'open',generation:1},{mode:'prepared',cutover:'open',generation:1}]},'marker_rows:2');
pre({fence:[{ok:0}]},'fence_not_ok:0');
pre({fence:[]},'fence_rows:0');
pre({marker:[{mode:'r2',cutover:'open',generation:1}]},'marker_moved:r2/open/1');
pre({fence:[{ok:1},{ok:1}]},'fence_rows:2');
pre({baseline:[{state:'verified',reference:REF},{state:'verified',reference:REF}]},'baseline_rows:2');
pre({projector_window:[{state:'idle',expires_at:null},{state:'idle',expires_at:null}]},'projector_window_rows:2');
pre({other_counts:[preflight.other_counts[0],preflight.other_counts[0]]},'other_counts_rows:2');
pre({class_counts:[preflight.class_counts[0],preflight.class_counts[0]]},'class_counts_rows:2');
pre({baseline:[{state:'loading',reference:REF}]},'baseline_not_verified:loading');
pre({baseline:[{state:'verified',reference:'t'}]},'baseline_reference_shape');
pre({baseline:[{state:'verified',reference:'cutover_accepted/v2:abc'}]},'baseline_reference_shape');
pre({baseline:[{state:'verified',reference:'cutover_accepted/v2:'+'cd'.repeat(32)}]},'baseline_reference_mismatch');
pre({baseline:[]},'baseline_rows:0');
// the lease at the preflight: free means no row, lease_id null, or an expired lease
pre({projector_lease:[{lease_id:'a',lease_until:'2026-11-12T10:30:00.000Z'}]},'projector_lease_live');
pre({projector_lease:[{lease_id:'a',lease_until:null}]},'projector_lease_live');
pre({projector_lease:[{lease_id:'a',lease_until:'2026-11-12T09:00:00.000Z'},{lease_id:null,lease_until:null}]},'projector_lease_rows:2');
assert.equal(K.verifyState('preflight',{...clone(preflight),projector_lease:[{lease_id:'a',lease_until:'2026-11-12T09:00:00.000Z'}]},P1).ok,true,'an expired lease is free');
assert.equal(K.verifyState('preflight',{...clone(preflight),projector_lease:[{lease_id:null,lease_until:null}]},P1).ok,true,'a released lease is free');
assert.equal(K.verifyState('preflight',{...clone(preflight),projector_lease:[{lease_id:'a',lease_until:NOW}]},P1).ok,false,'a lease expiring exactly now is still live');
// window and Discovery
pre({projector_window:[{state:'requested',expires_at:1}]},'projector_window_not_idle:requested');
pre({projector_window:[]},'projector_window_rows:0');
pre({discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)+1000}]},'discovery_lease_live');
pre({discovery_lease:[{id:1,lease_id:'x',expires_at:null}]},'discovery_lease_live');
assert.equal(K.verifyState('preflight',{...clone(preflight),discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)-1000}]},P1).ok,true);
assert.equal(K.verifyState('preflight',{...clone(preflight),discovery_lease:[{id:1,lease_id:null,expires_at:0}]},P1).ok,true);
// tables, receipts
pre({receipt_tables:preflight.receipt_tables.slice(1)},'receipt_tables_missing');
pre({loader_tables:preflight.loader_tables.slice(1)},'loader_tables_missing');
pre({other_counts:[{...preflight.other_counts[0],canonical_receipt_baseline:1}]},'receipt_rows_present:canonical_receipt_baseline:1');
pre({other_counts:[{...preflight.other_counts[0],canonical_write_receipt:'x'}]},'count_unreadable:canonical_write_receipt');
pre({other_counts:[]},'other_counts_rows:0');
const noted=K.verifyState('preflight',{...clone(preflight),other_counts:[{...preflight.other_counts[0],canonical_revision:3}]},P1);
assert.equal(noted.ok,true);assert.ok(noted.notes.includes('canonical_revision_not_empty:3'));
// the three classes must be empty before the load
pre({class_counts:[{film_rated_admission:1,film_retention:0,tmdb_retirement_decision:0}]},'class_not_empty:film_rated_admission:1');
pre({class_counts:[{film_rated_admission:0,film_retention:401,tmdb_retirement_decision:4}]},['class_not_empty:film_retention:401','class_not_empty:tmdb_retirement_decision:4']);
pre({class_counts:[{film_rated_admission:0,film_retention:0}]},'count_unreadable:tmdb_retirement_decision');
pre({class_counts:[]},'class_counts_rows:0');
pre({schema:'rows'},'result_malformed:schema');
pre({marker:[['prepared']]},'result_malformed:marker');
assert.deepEqual(K.verifyState('preflight',{...clone(preflight),schema:[{id:1,version:20,note:'x'}],projector_window:[{state:'held',expires_at:1}]},P1).refusals,['schema_version:20','projector_window_not_idle:held']);
// pins: without the GO's values the verification refuses, with a named reason
assert.deepEqual(K.verifyState('preflight',preflight,{now:NOW}).refusals,['expected_reference_missing']);
assert.deepEqual(K.verifyState('preflight',preflight,{expectReference:'x',now:NOW}).refusals,['expected_reference_invalid','baseline_reference_mismatch']);
assert.deepEqual(K.verifyState('preflight',preflight,{expectReference:REF,now:'yesterday'}).refusals,['now_invalid']);
assert.deepEqual(K.verifyState('preflight',preflight,{expectReference:REF,now:'2026-11-12T10:00:00Z'}).refusals,['now_invalid']);
assert.equal(K.verifyState('held',held,{expectReference:REF,now:NOW}).refusals[0],'lease_id_missing');
assert.equal(K.verifyState('held',held,{expectReference:REF,leaseId:'a b',now:NOW}).refusals[0],'lease_id_invalid');
assert.equal(K.verifyState('readback',loaded(),{...H1,held}).refusals[0],'counts_missing');
assert.equal(K.verifyState('readback',loaded(),{...H1,held,counts:[0,0,0]}).refusals[0],'counts_invalid');
assert.equal(K.verifyState('readback',loaded(),{...H1,held,counts:[708,401]}).refusals[0],'counts_invalid');
assert.equal(K.verifyState('readback',loaded(),{...H1,held,counts:[708,-1,4]}).refusals[0],'counts_invalid');
assert.deepEqual(K.verifyState('readback',loaded(),{...H1,counts:COUNTS}).refusals,['held_bundle_missing']);
// held: the lease must be the run's own, live, with time left
hld({projector_lease:[]},'projector_lease_rows:0');
hld({projector_lease:[{lease_id:'someone-else-1',lease_until:'2026-11-12T10:45:00.000Z'}]},'projector_lease_not_ours:someone-else-1');
hld({projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T10:14:59.000Z'}]},'projector_lease_expiring');
hld({projector_lease:[{lease_id:LEASE,lease_until:null}]},'projector_lease_expiring');
hld({projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T10:45:00.000Z'},{lease_id:LEASE,lease_until:'x'}]},'projector_lease_rows:2');
assert.equal(K.verifyState('held',{...clone(held),projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T10:15:00.000Z'}]},H1).ok,true,'exactly 15 minutes left is enough');
hld({class_counts:[{film_rated_admission:5,film_retention:0,tmdb_retirement_decision:0}]},'class_not_empty:film_rated_admission:5');
hld({discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)+1}]},'discovery_lease_live');
hld({projector_window:[{state:'held',expires_at:1}]},'projector_window_not_idle:held');
// readback: the pinned counts, the lease still ours, nothing else moved against the held bundle
rdb({class_counts:[{film_rated_admission:707,film_retention:401,tmdb_retirement_decision:4}]},'count_not_expected:film_rated_admission:707');
rdb({class_counts:[{film_rated_admission:708,film_retention:402,tmdb_retirement_decision:4}]},'count_not_expected:film_retention:402');
rdb({class_counts:[{film_rated_admission:708,film_retention:401,tmdb_retirement_decision:3}]},'count_not_expected:tmdb_retirement_decision:3');
rdb({class_counts:[{film_rated_admission:0,film_retention:0,tmdb_retirement_decision:0}]},COUNTS.map((n,i)=>'count_not_expected:'+L.TABLES[L.CLASSES[i]]+':0'));
rdb({projector_lease:[]},'projector_lease_rows:0');
rdb({projector_lease:[{lease_id:'someone-else-1',lease_until:'2026-11-12T10:45:00.000Z'}]},'projector_lease_not_ours:someone-else-1');
rdb({projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T09:59:59.000Z'}]},'projector_lease_expiring');
rdb({marker:[{mode:'d1',cutover:'open',generation:2}]},'marker_moved:d1/open/2');
rdb({baseline:[{state:'verified',reference:'cutover_accepted/v2:'+'cd'.repeat(32)}]},['baseline_reference_mismatch','baseline_reference_changed']);
rdb({other_counts:[{...held.other_counts[0],film:101}]},'unchanged_moved:film:100->101');
rdb({other_counts:[{...held.other_counts[0],person:49}]},'unchanged_moved:person:50->49');
rdb({other_counts:[{...held.other_counts[0],film_external_id:301}]},'unchanged_moved:film_external_id:300->301');
rdb({other_counts:[{...held.other_counts[0],film_redirect:3}]},'unchanged_moved:film_redirect:2->3');
rdb({other_counts:[{...held.other_counts[0],canonical_revision:1}]},'unchanged_moved:canonical_revision:0->1');
rdb({other_counts:[{...held.other_counts[0],canonical_write_receipt:1}]},'receipt_rows_present:canonical_write_receipt:1');
rdb({projector_window:[{state:'idle',expires_at:5}]},'projector_window_changed');
const moved=K.verifyState('readback',{...loaded(),discovery_lease:[{id:1,lease_id:'chunk-1',expires_at:Date.parse(NOW)+60000}]},R1);
assert.equal(moved.ok,true);assert.ok(moved.notes.some(item=>item.startsWith('discovery_lease_moved')),'a Discovery chunk during the load is recorded, not a refusal');
assert.equal(K.verifyState('readback',{...loaded(),projector_window:[{expires_at:null,state:'idle'}]},R1).ok,true,'row comparison ignores key order');
// the held bundle is judged too, by its own identity
assert.deepEqual(K.verifyState('readback',loaded(),{...R1,held:{...clone(held),projector_lease:[]}}).refusals,['held:projector_lease_not_ours']);
assert.deepEqual(K.verifyState('readback',loaded(),{...R1,held:{...clone(held),marker:[{mode:'d1',cutover:'open',generation:2}]}}).refusals,['held:marker_moved:d1/open/2']);
assert.deepEqual(K.verifyState('readback',loaded(),{...R1,held:{...clone(held),class_counts:[{film_rated_admission:1,film_retention:0,tmdb_retirement_decision:0}]}}).refusals,['held:class_not_empty:film_rated_admission:1']);
assert.equal(K.verifyState('readback',loaded(),{...R1,held:{...clone(held),projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T09:00:00.000Z'}]}}).ok,true,'the held bundle is not judged against the clock of the readback');
assert.deepEqual(K.verifyState('readback',loaded(),{...R1,held:{...clone(held),discovery_lease:[{id:1,lease_id:'x',expires_at:Date.parse(NOW)+1}]}}).refusals,[],'the held bundle is judged for the lease it held, not re-judged for Discovery');
// released: the lease is gone and the counts stand
check('released',{...released(),projector_lease:[{lease_id:LEASE,lease_until:'2026-11-12T10:45:00.000Z'}]},R1,'lease_not_released');
check('released',{...released(),projector_lease:[{lease_id:'someone-else-1',lease_until:'2026-11-12T10:45:00.000Z'}]},R1,'projector_lease_foreign');
check('released',{...released(),projector_lease:[{lease_id:null,lease_until:null},{lease_id:null,lease_until:null}]},R1,'projector_lease_rows:2');
assert.equal(K.verifyState('released',{...released(),projector_lease:[{lease_id:null,lease_until:null}]},R1).ok,true);
check('released',{...released(),class_counts:[{film_rated_admission:700,film_retention:401,tmdb_retirement_decision:4}]},R1,'count_not_expected:film_rated_admission:700');
check('released',released(),{...R1,held:undefined},'held_bundle_missing');
check('released',{...released(),other_counts:[{...held.other_counts[0],film:99}]},R1,'unchanged_moved:film:100->99');

// ---------- diagnostic mode: shape only, never a pass ----------
const diagnostic=K.verifyState('preflight',preflight,{diagnostic:true});
assert.equal(diagnostic.ok,false);assert.equal(diagnostic.diagnosticOnly,true);assert.equal(diagnostic.shapeOk,true);assert.deepEqual(diagnostic.refusals,[]);
assert.equal(K.verifyState('held',held,{diagnostic:true}).ok,false);
const badShape=K.verifyState('preflight',{...clone(preflight),schema:[{id:1,version:18,note:'x'}]},{diagnostic:true});
assert.equal(badShape.ok,false);assert.equal(badShape.shapeOk,false);assert.deepEqual(badShape.refusals,['schema_version:18']);
assert.equal(K.verifyState('readback',loaded(),{diagnostic:true}).ok,false);
assert.equal(K.verifyState('readback',loaded(),{diagnostic:true,leaseId:LEASE,held,now:NOW,counts:COUNTS}).shapeOk,true);

// ---------- the plan summary printed by `plan` ----------
const SOURCES={verifiedFilms:hex('1'),viewIndex:hex('2'),retirements:hex('3')};
const planSummary=()=>({ok:true,mode:'dry-run',version:L.LOADER_VERSION,digest:hex('9'),gate:{mode:'prepared',cutover:'open',generation:1,baselineReference:REF},at:'2026-11-12T10:00:00.000Z',complete:true,noop:false,
 sources:{verifiedFilms:{key:L.SOURCE_KEYS.verifiedFilms,sha256:SOURCES.verifiedFilms,size:1000},viewIndex:{key:L.SOURCE_KEYS.viewIndex,sha256:SOURCES.viewIndex,size:2000},retirements:{key:L.SOURCE_KEYS.retirements,sha256:SOURCES.retirements,size:300}},
 classes:Object.fromEntries(L.CLASSES.map((name,i)=>[name,{expected:L.EXPECTED[name],planned:COUNTS[i],already:0,toLoad:COUNTS[i],stored:0,digest:hex('a'),toLoadDigest:hex('a'),skipped:{unverified:0}}])),
 batches:18+11+1,statements:1113,deferred:0,bounds:{batchRows:40,runBatches:40,runStatements:1200}});
// the batch arithmetic of the loader: 708 -> 18 batches, 401 -> 11, 4 -> 1
assert.equal(Math.ceil(708/40)+Math.ceil(401/40)+Math.ceil(4/40),30);
const PP={planDigest:hex('9'),counts:COUNTS,expectReference:REF,at:'2026-11-12T10:00:00.000Z',sources:SOURCES};
assert.deepEqual(K.verifyPlan(planSummary(),PP),{ok:true,refusals:[],notes:[],total:1113,batches:30});
const plan=(mutate,want,opts=PP)=>{const value=planSummary();mutate(value);const result=K.verifyPlan(value,opts);assert.equal(result.ok,false);assert.deepEqual(result.refusals,[].concat(want));};
plan(v=>{v.ok=false;},'plan_not_ok');
plan(v=>{v.mode='apply';},'plan_not_dry_run');
plan(v=>{v.version=2;},'plan_version:2');
plan(v=>{v.digest='short';},'plan_digest_shape');
plan(v=>{v.digest=hex('8');},'plan_digest_mismatch');
plan(v=>{v.gate.mode='d1';},'gate_not_prepared:d1/open/1');
plan(v=>{v.gate.cutover='held';},'gate_not_prepared:prepared/held/1');
plan(v=>{v.gate.generation=2;},'gate_not_prepared:prepared/open/2');
plan(v=>{v.gate.baselineReference='cutover_accepted/v2:'+'cd'.repeat(32);},'gate_reference_mismatch');
plan(v=>{delete v.gate;},'gate_not_prepared:missing');
plan(v=>{v.at='2026-11-12T10:00:01.000Z';},'plan_at_mismatch');
plan(v=>{v.complete=false;},'plan_incomplete');
plan(v=>{v.noop=true;},'plan_noop');
plan(v=>{v.deferred=40;},'plan_deferred:40');
plan(v=>{v.bounds.batchRows=60;},'bounds_invalid');
plan(v=>{v.bounds.runBatches=41;},'bounds_invalid');
plan(v=>{v.bounds.runStatements=1201;},'bounds_invalid');
plan(v=>{delete v.bounds;},'bounds_invalid');
plan(v=>{v.sources.viewIndex.sha256=hex('4');},'source_sha_mismatch:viewIndex');
plan(v=>{v.sources.retirements.key='identity/other.json';},'source_invalid:retirements');
plan(v=>{v.sources.verifiedFilms.size=0;},'source_invalid:verifiedFilms');
plan(v=>{v.sources.verifiedFilms.size=L.MAX_SOURCE_BYTES+1;},'source_invalid:verifiedFilms');
plan(v=>{v.sources.viewIndex.sha256='zz';},'source_invalid:viewIndex');
plan(v=>{delete v.sources;},['source_invalid:verifiedFilms','source_invalid:viewIndex','source_invalid:retirements']);
plan(v=>{v.classes.retention.planned=400;},'class_planned_not_pinned:retention:400');
plan(v=>{v.classes.retention.toLoad=400;v.statements=1112;},['class_toload_not_pinned:retention:400','batches_not_expected:30/29']);
plan(v=>{v.classes.ratedAdmission.already=1;},'class_already_loaded:ratedAdmission:1');
plan(v=>{v.classes.retirement.stored=2;},'class_not_empty:retirement:2');
plan(v=>{v.classes.retirement.expected=5;},'class_expected_not_loader:retirement:5');
plan(v=>{v.classes.retention.digest='x';},'class_digest_shape:retention');
plan(v=>{v.classes.retention.toLoadDigest=hex('b');},'class_digest_not_whole_set:retention');
plan(v=>{delete v.classes.retirement;},['class_missing:retirement','statements_not_total:1113/1109','batches_not_expected:30/29']);
plan(v=>{v.statements=1112;},'statements_not_total:1112/1113');
plan(v=>{v.batches=31;},'batches_not_expected:31/30');
plan(v=>{v.expectedRows={};},'private_plan_pasted');
plan(v=>{v.batchStatements=[];},'private_plan_pasted');
const big=planSummary();big.classes.ratedAdmission.toLoad=1000;big.classes.retention.toLoad=200;
assert.ok(K.verifyPlan(big,PP).refusals.includes('run_cap_exceeded'),'more than 1,200 statements in one run');
const skipped=planSummary();skipped.classes.ratedAdmission.skipped={unverified:0,noFilm:2};
const skippedResult=K.verifyPlan(skipped,PP);
assert.equal(skippedResult.ok,true);assert.deepEqual(skippedResult.notes,['skipped ratedAdmission: noFilm=2 (accepted gaps counted, not loaded)']);
// a plan for counts the loader does not expect (a changed count is a reviewed loader change, not a verifier input)
plan(()=>{},['class_planned_not_pinned:ratedAdmission:708','class_toload_not_pinned:ratedAdmission:708'],{...PP,counts:[709,401,4]});
// pins are mandatory
assert.deepEqual(K.verifyPlan(planSummary(),{}).refusals,['plan_digest_missing','expected_reference_missing','counts_missing','at_invalid','source_sha_missing:verifiedFilms','source_sha_missing:viewIndex','source_sha_missing:retirements']);
assert.deepEqual(K.verifyPlan(planSummary(),{...PP,planDigest:'zz'}).refusals,['plan_digest_invalid','plan_digest_mismatch']);
assert.deepEqual(K.verifyPlan(planSummary(),{...PP,counts:[0,0,0]}).refusals.slice(0,1),['counts_invalid']);
assert.deepEqual(K.verifyPlan(planSummary(),{...PP,sources:{...SOURCES,viewIndex:'zz'}}).refusals.slice(0,1),['source_sha_invalid:viewIndex']);
assert.deepEqual(K.verifyPlan(planSummary(),{...PP,at:'x'}).refusals.slice(0,1),['at_invalid']);
assert.deepEqual(K.verifyPlan(null,PP).refusals,['plan_malformed']);
assert.deepEqual(K.verifyPlan([],PP).refusals,['plan_malformed']);
const planDiagnostic=K.verifyPlan(planSummary(),{diagnostic:true});
assert.equal(planDiagnostic.ok,false);assert.equal(planDiagnostic.diagnosticOnly,true);assert.equal(planDiagnostic.shapeOk,true);

// ---------- the batch list printed by `sql --apply` ----------
const emittedList=()=>{const batches=[];let index=0,digit=0;for(const [cls,count] of [['ratedAdmission',708],['retention',401],['retirement',4]])for(let left=count;left>0;left-=40)batches.push({index:index++,class:cls,rows:Math.min(40,left),digest:hex('0123456789abcdef'[digit++%16])+''});return batches;};
// 30 distinct digests: make them distinct
const distinct=list=>list.map((batch,i)=>({...batch,digest:i.toString(16).padStart(2,'0').repeat(32)}));
const emitted=()=>({ok:true,planDigest:hex('9'),batches:distinct(emittedList()),note:'emitted, not executed'});
const EP={planDigest:hex('9'),counts:COUNTS};
const good=K.verifyEmitted(emitted(),EP);
assert.equal(good.ok,true);assert.deepEqual(good.refusals,[]);assert.equal(good.batches,30);assert.equal(good.total,1113);assert.match(good.batchSetDigest,/^[0-9a-f]{64}$/);
assert.equal(K.verifyEmitted(emitted(),{...EP,batchSetDigest:good.batchSetDigest}).ok,true);
const emit=(mutate,want,opts=EP)=>{const value=emitted();mutate(value);const result=K.verifyEmitted(value,opts);assert.equal(result.ok,false);assert.deepEqual(result.refusals,[].concat(want));};
emit(()=>{},'batch_set_digest_mismatch',{...EP,batchSetDigest:hex('f')});
emit(v=>{v.ok=false;},'emitted_not_ok');
emit(v=>{v.planDigest=hex('8');},'plan_digest_mismatch');
emit(v=>{v.planDigest='x';},'plan_digest_shape');
emit(v=>{delete v.batches;},'batches_missing');
emit(v=>{v.batches=[];},'batches_missing');
emit(v=>{v.batches[3].index=9;},'batch_index:3:9');
emit(v=>{v.batches[0].class='nothing';},['batch_class:0','class_rows_not_pinned:ratedAdmission:668']);
emit(v=>{v.batches[18].class='ratedAdmission';},['class_rows_not_pinned:ratedAdmission:748','class_rows_not_pinned:retention:361']);
emit(v=>{v.batches[0].rows=41;},['batch_rows:0:41','class_rows_not_pinned:ratedAdmission:709']);
emit(v=>{v.batches[0].rows=0;},['batch_rows:0:0','class_rows_not_pinned:ratedAdmission:668']);
emit(v=>{v.batches[1].digest='x';},'batch_digest_shape:1');
emit(v=>{v.batches[2].digest=v.batches[1].digest;},'batch_digest_duplicate:2');
emit(v=>{v.batches.push({index:30,class:'retirement',rows:1,digest:hex('e')});},['class_rows_not_pinned:retirement:5']);
emit(v=>{v.batches[0]=null;},['batch_malformed:0','class_rows_not_pinned:ratedAdmission:668']);
emit(v=>{v.statements=[];},'sql_pasted');
emit(v=>{v.sql='INSERT';},'sql_pasted');
assert.ok(K.verifyEmitted({...emitted(),batches:[...emitted().batches,...Array.from({length:11},(_,i)=>({index:30+i,class:'retirement',rows:1,digest:(i+100).toString(16).padStart(2,'0').repeat(32).slice(0,64)}))]},EP).refusals.includes('run_cap_exceeded'));
// the order of the classes: a retention batch before an admission batch is refused
const swapped=emitted();[swapped.batches[17],swapped.batches[18]]=[{...swapped.batches[18],index:17},{...swapped.batches[17],index:18}];
assert.ok(K.verifyEmitted(swapped,EP).refusals.includes('batch_order:18'));
const heavy=emitted();heavy.batches=Array.from({length:40},(_,i)=>({index:i,class:'ratedAdmission',rows:40,digest:i.toString(16).padStart(2,'0').repeat(32)}));
assert.ok(K.verifyEmitted(heavy,EP).refusals.includes('run_cap_exceeded'),'40 batches of 40 rows are 1,600 statements');
const other=emitted();other.batches[0].digest=hex('7');
assert.notEqual(K.verifyEmitted(other,EP).batchSetDigest,good.batchSetDigest,'the batch set digest covers every batch digest');
assert.deepEqual(K.verifyEmitted(emitted(),{}).refusals,['plan_digest_missing','counts_missing']);
assert.deepEqual(K.verifyEmitted(emitted(),{planDigest:'zz',counts:COUNTS}).refusals,['plan_digest_invalid','plan_digest_mismatch']);
assert.deepEqual(K.verifyEmitted(emitted(),{planDigest:hex('9'),counts:[0,0,0]}).refusals.slice(0,1),['counts_invalid']);
assert.deepEqual(K.verifyEmitted(null,EP).refusals,['output_malformed']);
const emitDiagnostic=K.verifyEmitted(emitted(),{diagnostic:true});
assert.equal(emitDiagnostic.ok,false);assert.equal(emitDiagnostic.diagnosticOnly,true);assert.equal(emitDiagnostic.shapeOk,true);
assert.equal(K.verifyEmitted(emitted(),{...EP,batchSetDigest:hex('f'),diagnostic:true}).shapeOk,true,'a diagnostic does not judge the pins');

// ---------- the D1 result of one sent batch ----------
const results=(n,changes=1)=>Array.from({length:n},()=>({success:true,meta:{changes}}));
assert.deepEqual(K.verifyBatch(results(40),{rows:40}),{ok:true,refusals:[],notes:['a refusal here is a STOP: read the class counts first, never resend the batch']});
assert.equal(K.verifyBatch(results(4).map(item=>({success:true,changes:1})),{rows:4}).ok,true,'changes at the top level');
const batch=(value,rows,want)=>{const result=K.verifyBatch(value,{rows});assert.equal(result.ok,false);assert.deepEqual(result.refusals,[].concat(want));};
batch(results(39),40,'result_count:39/40');
batch(results(41),40,'result_count:41/40');
batch(results(40,0),40,Array.from({length:40},(_,i)=>'statement_no_change:'+i));
batch([...results(2),{success:false,meta:{changes:0}}],3,'statement_failed:2');
batch([...results(1),{meta:{changes:1}}],2,'statement_failed:1');
batch([{success:true,meta:{changes:2}}],1,'statement_changes:0:2');
batch([{success:true,meta:{}}],1,'changes_unreadable:0');
batch([{success:true,meta:{changes:'1'}}],1,'changes_unreadable:0');
batch([null],1,'result_malformed:0');
batch({success:true},1,'response_malformed');
batch(null,1,'response_malformed');
batch(results(1),0,'rows_invalid');
batch(results(1),41,'rows_invalid');
batch(results(1),null,'rows_invalid');
batch(results(1),1.5,'rows_invalid');
assert.equal(K.verifyBatch(results(40),{rows:40,diagnostic:true}).ok,false);
assert.equal(K.verifyBatch(results(40),{diagnostic:true}).shapeOk,true);
assert.equal(K.verifyBatch(results(3,0),{rows:3,diagnostic:true}).shapeOk,false);

// ---------- the CLI: refusal exit status, and nothing written but standard output ----------
const logged=[];
const logOriginal=console.log,errorOriginal=console.error;
const cli=argv=>{logged.length=0;console.log=line=>logged.push(line);console.error=()=>{};try{return K.main(argv);}finally{console.log=logOriginal;console.error=errorOriginal;}};
const write=(name,value)=>{const file=path.join(root,name);fs.writeFileSync(file,JSON.stringify(value));return file;};
const fPre=write('pre.json',preflight),fHeld=write('held.json',held),fLoaded=write('loaded.json',loaded()),fPlan=write('plan.json',planSummary()),fEmit=write('emit.json',emitted()),fBatch=write('batch.json',results(2));
assert.equal(cli(['state-sql']),0);assert.equal(JSON.parse(logged[0]).steps.length,11);
assert.equal(cli(['verify-preflight',fPre,'--reference',REF,'--now',NOW]),0);
assert.equal(cli(['verify-preflight',fPre,'--now',NOW]),1,'no pinned reference');assert.deepEqual(JSON.parse(logged[0]).refusals,['expected_reference_missing']);
assert.equal(cli(['verify-preflight',fPre,'--diagnostic']),1);assert.equal(JSON.parse(logged[0]).diagnosticOnly,true);
assert.equal(cli(['verify-held',fHeld,'--reference',REF,'--lease-id',LEASE,'--now',NOW]),0);
assert.equal(cli(['verify-held',fHeld,'--reference',REF,'--now',NOW]),1);
assert.equal(cli(['verify-readback',fLoaded,'--held',fHeld,'--reference',REF,'--lease-id',LEASE,'--counts','708,401,4','--now',NOW]),0);
assert.equal(cli(['verify-readback',fLoaded,'--reference',REF,'--lease-id',LEASE,'--counts','708,401,4','--now',NOW]),1);
assert.equal(cli(['verify-readback',fLoaded,'--held',fHeld,'--reference',REF,'--lease-id',LEASE,'--now',NOW]),1,'counts are mandatory');
assert.equal(cli(['verify-plan',fPlan,'--plan-digest',hex('9'),'--counts','708,401,4','--reference',REF,'--at','2026-11-12T10:00:00.000Z','--verified-films-sha',SOURCES.verifiedFilms,'--view-index-sha',SOURCES.viewIndex,'--retirements-sha',SOURCES.retirements]),0);
assert.equal(cli(['verify-plan',fPlan,'--plan-digest',hex('9'),'--counts','708,401,4','--reference',REF,'--at','2026-11-12T10:00:00.000Z']),1,'source digests are mandatory');
assert.equal(cli(['verify-emitted',fEmit,'--plan-digest',hex('9'),'--counts','708,401,4']),0);
assert.equal(cli(['verify-emitted',fEmit,'--plan-digest',hex('9')]),1);
assert.equal(cli(['verify-batch',fBatch,'--rows','2']),0);
assert.equal(cli(['verify-batch',fBatch,'--rows','3']),1);
assert.equal(cli(['verify-batch',fBatch]),1);
assert.equal(cli(['nothing']),2);
assert.equal(cli(['verify-preflight']),2);

// ---------- the module has no write path ----------
const source=fs.readFileSync('scripts/film-person-h1-verify.mjs','utf8');
assert.ok(!/\b(fetch|XMLHttpRequest|child_process|writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync)\b/.test(source),'no network, process or file write');
assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(source.replace(/\/\/.*$/gm,'').replace(/'[^']*'/g,'')),'no write SQL outside quoted refusals');
assert.ok(!/emitLoadSql|insertStatement|buildLoadPlan/.test(source),'it never builds a plan or a write statement');
console.log('film-person-h1-verify: ok');
