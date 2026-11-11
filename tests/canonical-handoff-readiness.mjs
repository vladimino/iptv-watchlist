// AIR-374 P6 (offline) / ADR 0117: the COMPUTED handoffReadiness (src/canonical-producers.js). Read-only and dormant. On the real migration chain over the sqlite3-CLI D1 stand-in:
// today's repository is NOT ready (receipts missing, producers unwired, readers unmoved, classes unloaded, named differences not accepted); a synthetic, fully satisfied fixture
// is ready; every blocker flips independently; the registries are data, so editing a comment changes nothing. PRODUCERS_SOURCE points the test at a mutant copy
// (tests/canonical-handoff-readiness-mutation.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {copyOf,envOf,fresh,opened,root,sqlite} from './canonical-differential-helper.mjs';
import {P6_DIFFERENTIAL_EXCEPTIONS} from '../src/canonical-film-writers.js';
import {EXTRA_EXCEPTIONS,DIFFERENTIAL_COVERAGE} from '../src/canonical-differential-registry.js';
import {OPERATION_KINDS,operationRegistry,recordBaseline} from '../src/canonical-receipts.js';
import {mutateFilm} from '../src/canonical-mutations.js';

const ONLY=(process.env.READINESS_ONLY||'').split(',').filter(Boolean);
const on=key=>!ONLY.length||ONLY.some(item=>key.startsWith(item));
const NOW='2026-11-11T12:00:00.000Z',NOW_MS=Date.parse(NOW);
const source=process.env.PRODUCERS_SOURCE?path.resolve(process.env.PRODUCERS_SOURCE):'src/canonical-producers.js';
const mod=await import(pathToFileURL(source).href);
const {handoffReadiness,CALLS,RECONCILE,GAPS,PRODUCER_WIRING,PRODUCER_OPERATIONS,READER_REGISTRY,RECEIPTS_PROTOCOL,EMPTY_CLASSES}=mod;
const ALL_EXCEPTIONS=[...P6_DIFFERENTIAL_EXCEPTIONS,...EXTRA_EXCEPTIONS];

// Production today is schema 18 (migration 0019 exists in the repository but is NOT applied there): the test chain includes 0019, so the production state is built by lowering the contract.
const production=file=>{sqlite(file,'DROP TRIGGER IF EXISTS schema_contract_no_downgrade;UPDATE schema_contract SET version=18 WHERE id=1');return file;};
// A synthetic fully satisfied fixture: schema 19 (the real receipt tables), the three classes loaded at SMALL counts (2, 1, 1), a free lease, an idle window, marker prepared with a
// verified baseline. The evidence replaces the registries only here: every producer wired, every reader moved, receipts registered, every named difference accepted.
const SMALL=[{name:'ratedAdmission',table:'film_rated_admission',expected:2},{name:'retention',table:'film_retention',expected:1},{name:'retirement',table:'tmdb_retirement_decision',expected:1}];
function satisfied(){
 const file=fresh();
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:1',1,'"+NOW+"'),('film:tmdb:2',1,'"+NOW+"');"
  +"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:1','1','a','"+'a'.repeat(64)+"','k','tmdb_1','"+NOW+"','r','"+NOW+"'),('film:tmdb:2','2','b','"+'a'.repeat(64)+"','k','tmdb_2','"+NOW+"','r','"+NOW+"');"
  +"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:1','watchlist_fact',1,'{}','r','"+NOW+"','"+NOW+"');"
  +"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('d1','film:tmdb:1','retire','abc','1','5','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request','{}','"+NOW+"');");
 return file;
}
const specOf=operation=>({operation,readback(){return null;},replay(){return {revision:1};},atomic:true});
const registryOf=kinds=>operationRegistry(kinds.map(specOf));
const good=()=>({readers:READER_REGISTRY.map(item=>({...item,moved:true})),operations:registryOf(OPERATION_KINDS),classes:SMALL,exceptions:ALL_EXCEPTIONS.map(item=>({...item,status:'accepted'}))});
const run=async(file,evidence)=>handoffReadiness(envOf(file),{now:NOW,evidence});
const only=async(label,file,evidence,...expected)=>{const out=await run(file,evidence);assert.deepEqual(out.blockers,expected,label+': exactly this blocker, no other: '+out.blockers);assert.equal(out.ready,false,label);return out;};

// 1. The fully satisfied synthetic fixture is READY, with every former gap cleared by evidence.
if(on('1')){
 const out=await run(satisfied(),good());
 assert.deepEqual(out.blockers,[],'no blocker: '+out.blockers);
 assert.equal(out.ready,true);
 assert.deepEqual([out.gaps.length,out.clearedGaps.length],[0,GAPS.length]);
}

// 2. Today's repository (the real registries, a prepared and verified marker, empty classes) is NOT ready; the exact remaining blockers.
if(on('2')){
 const out=await handoffReadiness(envOf(production(fresh())),{now:NOW});
 assert.equal(out.ready,false);
 const expected=[
  ...ALL_EXCEPTIONS.filter(item=>item.status!=='accepted').map(item=>'exception_not_accepted:'+item.id),
  'receipts_schema_missing','receipts_protocol_unregistered',
  ...PRODUCER_WIRING.map(item=>'producer_not_wired:'+item.name),
  ...['worker_programme_read','worker_watchlist_read','worker_catalog_read','admin_read','admin_limbo','admin_health','owner_review_d1_gate'].map(name=>'reader_not_moved:'+name),
  ...EMPTY_CLASSES.map(item=>'empty_class_not_loaded:'+item.name+':0/'+item.expected),
 ];
 assert.deepEqual(out.blockers,expected,'the computed blockers of this repository');
 assert.deepEqual(out.blockers.filter(item=>/^(gap|marker|baseline|schema|projector)/.test(item)),[],'the marker, baseline, schema, lease and window are not what blocks');
 assert.deepEqual(EMPTY_CLASSES.map(item=>item.expected),[708,401,4],'the accepted class counts');
 assert.deepEqual(PRODUCER_WIRING.map(item=>item.name),['epg_commit','metadata_sync','discovery_admission','rated_admission_retention']);
 assert.equal(PRODUCER_OPERATIONS.size,0,'no producer operation is registered');assert.equal(RECEIPTS_PROTOCOL.minSchema,19);
 fs.writeFileSync(path.join(root,'today.json'),JSON.stringify(out.blockers));
}

// 3. Each blocker flips INDEPENDENTLY from the ready fixture: it alone appears, and only it.
{
 const base=satisfied();
 // marker, baseline, schema, lease, window
 if(on('3a')){
 await only('marker open',opened(base),good(),'marker_not_prepared:open','receipts_baseline_missing');
 {const f=copyOf(base,'x');sqlite(f,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','l1','2099-01-01T00:00:00.000Z','2026-11-11T09:00:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='l1',lease_until='2099-01-01T00:00:00.000Z'");await only('live lease',f,good(),'projector_lease_live');}
 for(const state of ['requested','held']){const f=copyOf(base,'x');sqlite(f,"UPDATE projector_window SET state='"+state+"',owner='o',requested_at="+(NOW_MS-1000)+",expires_at="+(NOW_MS+60000)+" WHERE id=1");await only('window '+state,f,good(),'projector_window_not_idle:'+state);}
 {const f=copyOf(base,'x');sqlite(f,"UPDATE projector_window SET state='held',owner='o',requested_at="+(NOW_MS-200000)+",expires_at="+(NOW_MS-1000)+" WHERE id=1");assert.deepEqual((await run(f,good())).blockers,[],'an expired window is idle');}
 {const f=copyOf(base,'x');sqlite(f,"DROP TRIGGER IF EXISTS film_person_baseline_reopen_needs_r2;UPDATE film_person_baseline SET state='loading' WHERE id=1");await only('baseline not verified',f,good(),'baseline_not_verified:loading');}
 }
 // receipts
 if(on('3b')){
 {const f=copyOf(base,'x');sqlite(f,'DROP TABLE canonical_write_receipt');await only('receipt table absent',f,good(),'receipts_schema_missing');}
 {const f=copyOf(base,'x');sqlite(f,'DROP TABLE canonical_receipt_baseline_seal');await only('baseline seal table absent',f,good(),'receipts_schema_missing');}
 await only('schema below 19',production(copyOf(base,'x')),good(),'receipts_schema_missing');
 // the protocol and the producers come from the receipts registry: an empty registry, or one missing a kind, or a non-atomic operation
 await only('no operation registered',base,{...good(),operations:registryOf([])},'receipts_protocol_unregistered',...PRODUCER_WIRING.map(item=>'producer_not_wired:'+item.name));
 for(const kind of OPERATION_KINDS){
  const affected=PRODUCER_WIRING.filter(item=>item.requires.includes(kind)).map(item=>'producer_not_wired:'+item.name);
  assert.deepEqual((await run(base,{...good(),operations:registryOf(OPERATION_KINDS.filter(k=>k!==kind))})).blockers,affected,'kind '+kind+' unregistered blocks exactly the producers that need it');
 }
 const plain=new Map([...registryOf(OPERATION_KINDS)].map(([key,spec])=>[key,{...spec,atomic:false}]));
 assert.deepEqual((await run(base,{...good(),operations:plain})).blockers,['receipts_protocol_unregistered',...PRODUCER_WIRING.map(item=>'producer_not_wired:'+item.name)],'a non-atomic operation neither registers the protocol nor wires a producer');
 const NEEDS={film_mutation:['epg_commit','discovery_admission'],person_mutation:['epg_commit'],person_state:['epg_commit'],film_membership:['epg_commit'],localization_source:['metadata_sync'],film_admission:['rated_admission_retention'],film_retention:['rated_admission_retention']};
 for(const [kind,names] of Object.entries(NEEDS))assert.deepEqual((await run(base,{...good(),operations:registryOf(OPERATION_KINDS.filter(k=>k!==kind))})).blockers,names.map(name=>'producer_not_wired:'+name),kind+' is needed by exactly '+names);
 // the activation baseline is recorded after the flip: at open it is required, sealed it verifies, and what follows is read
 const opened1=opened(base);
 await mutateFilm(envOf(opened1),{id:'film:tmdb:76',expectedRevision:0,at:NOW,film:{contractVersion:1}});
 await recordBaseline(envOf(opened1));
 await only('open with a sealed baseline',opened1,good(),'marker_not_prepared:open');
 {const f=copyOf(opened1,'x');await mutateFilm(envOf(f),{id:'film:tmdb:77',expectedRevision:0,at:NOW,film:{contractVersion:1}});await only('post-boundary change without a receipt',f,good(),'marker_not_prepared:open','unreceipted_changes');}
 {const f=copyOf(opened1,'x');sqlite(f,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('r1','film_mutation','epg','film','film:tmdb:1','"+'a'.repeat(64)+"',0,2,'pending',1,'"+NOW+"','"+NOW+"','"+NOW+"');UPDATE canonical_write_receipt SET state='abandoned',error_class='stale_revision_needs_repair',next_attempt_at=NULL,settled_at='"+NOW+"' WHERE request_id='r1'");await only('abandoned receipt needs a person',f,good(),'marker_not_prepared:open','receipts_attention_open');}
 {const f=copyOf(opened1,'x');sqlite(f,"DROP TRIGGER canonical_receipt_baseline_no_update;UPDATE canonical_receipt_baseline SET revision=revision+1");assert.deepEqual((await run(f,good())).blockers.filter(item=>item.startsWith('receipts_')&&item!=='receipts_protocol_unregistered'),['receipts_baseline_unverified'],'a tampered baseline does not verify');}
 }
 // producers and readers, one at a time
 if(on('3c')){
 for(const item of READER_REGISTRY)await only('unmoved '+item.name,base,{...good(),readers:good().readers.map(r=>r.name===item.name?{...r,moved:false}:r)},'reader_not_moved:'+item.name);
 }
 // the three classes: one row fewer or more, and an unreadable table
 if(on('3d')){
 for(const [index,item] of SMALL.entries()){
  const more=copyOf(base,'x');
  if(item.name==='retention')sqlite(more,"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:2','watchlist_fact',0,'{}','r','"+NOW+"','"+NOW+"')");
  else if(item.name==='ratedAdmission')sqlite(more,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:3',1,'"+NOW+"');INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:3','3','c','"+'a'.repeat(64)+"','k','tmdb_3','"+NOW+"','r','"+NOW+"')");
  else sqlite(more,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('d2','film:tmdb:2','retire','abd','2','6','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request','{}','"+NOW+"')");
  await only('class too many '+item.name,more,good(),'empty_class_not_loaded:'+item.name+':'+(item.expected+1)+'/'+item.expected);
  await only('class off by expectation '+item.name,base,{...good(),classes:SMALL.map((c,i)=>i===index?{...c,expected:c.expected+5}:c)},'empty_class_not_loaded:'+item.name+':'+item.expected+'/'+(item.expected+5));
 }
 await only('class table unreadable',base,{...good(),classes:[...SMALL.slice(0,2),{name:'retirement',table:'no_such_table',expected:1}]},'empty_class_unreadable:retirement');
 }
 // each former gap: its writer missing from CALLS or from RECONCILE, an uncovered or empty coverage entry, or no entry
 if(on('3e')){
 for(const entry of DIFFERENTIAL_COVERAGE){
  const expectedBlocker='gap:'+entry.gap;
  await only('not covered '+entry.gap,base,{...good(),coverage:DIFFERENTIAL_COVERAGE.map(item=>item===entry?{...item,covered:false}:item)},expectedBlocker);
  await only('no scenarios '+entry.gap,base,{...good(),coverage:DIFFERENTIAL_COVERAGE.map(item=>item===entry?{...item,scenarios:[]}:item)},expectedBlocker);
  await only('no entry '+entry.gap,base,{...good(),coverage:DIFFERENTIAL_COVERAGE.filter(item=>item!==entry)},expectedBlocker);
 }
 const without=(table,name)=>Object.fromEntries(Object.entries(table).filter(([key])=>key!==name));
 for(const writer of new Set(DIFFERENTIAL_COVERAGE.flatMap(item=>item.writers))){
  const affected=DIFFERENTIAL_COVERAGE.filter(item=>item.writers.includes(writer)).map(item=>'gap:'+item.gap);
  assert.ok(typeof CALLS[writer]==='function'&&RECONCILE[writer],writer+' is registered for dispatch and readback today');
  assert.deepEqual((await run(base,{...good(),calls:{CALLS:without(CALLS,writer),RECONCILE}})).blockers,affected,writer+' missing from CALLS blocks exactly its gaps');
  assert.deepEqual((await run(base,{...good(),calls:{CALLS,RECONCILE:without(RECONCILE,writer)}})).blockers,affected,writer+' missing from RECONCILE blocks exactly its gaps');
 }
 }
 // every named difference the owner has not accepted blocks, one at a time
 if(on('3f')){
 for(const item of ALL_EXCEPTIONS)await only('exception '+item.id,base,{...good(),exceptions:good().exceptions.map(x=>x.id===item.id?{...x,status:'draft'}:x)},'exception_not_accepted:'+item.id);
 }
}
// 4. Read-only: only SELECT statements, no batch, and the database is byte-for-byte the same file content afterwards.
if(on('4')){
 const file=satisfied();const seen=[];
 const env={DB:d1Standin(file,{onQuery:async text=>{seen.push(text);}})};
 const before=fs.readFileSync(file);
 const out=await handoffReadiness(env,{now:NOW,evidence:good()});
 assert.equal(out.ready,true);
 assert.ok(seen.length>0&&seen.every(text=>/^\s*SELECT/i.test(text)),'only SELECT statements: '+seen.filter(text=>!/^\s*SELECT/i.test(text)));
 assert.equal(env.DB.calls.batches,0);
 assert.ok(before.equals(fs.readFileSync(file)),'the database file is unchanged');
 // an unreadable marker, a missing database and a missing contract are blockers, never ready
 assert.ok((await handoffReadiness({},{now:NOW})).blockers.some(item=>item==='no_database'||item.startsWith('marker_unreadable')||item.startsWith('marker_not')));
 assert.equal((await handoffReadiness({},{now:NOW})).ready,false);
}

// 5. The registries are DATA: a comment cannot change a blocker. A copy of the module whose comments are removed, and one whose comments claim everything is wired,
// moved, covered and registered, give exactly today's blockers; only editing the data (a boolean in the registry) flips a blocker.
if(on('5')){
 const text=fs.readFileSync(source,'utf8');
 const stripped=text.replace(/^\s*\/\/.*$/gm,'');
 const boasting=text.replace(/^(export const (PRODUCER_WIRING|PRODUCER_OPERATIONS|READER_REGISTRY|RECEIPTS_PROTOCOL|EMPTY_CLASSES|GAPS))/gm,'// wired: true atomic: true registered: true moved: true covered: true cleared\n$1');
 assert.notEqual(stripped,text);assert.notEqual(boasting,text);
 const today=JSON.parse(fs.readFileSync(path.join(root,'today.json'),'utf8'));
 const load=async(body,name)=>{
  const dir=path.dirname(path.resolve(source));
  const rewritten=body.replace(/from '\.\/([^']+)'/g,(_,file)=>"from '"+pathToFileURL(path.join(dir,file)).href+"'");
  const file=path.join(root,name);fs.writeFileSync(file,rewritten);
  return import(pathToFileURL(file).href);
 };
 for(const [label,body] of [['comments removed',stripped],['boasting comments',boasting]]){
  const copy=await load(body,label.replace(/\W/g,'')+'.mjs');
  assert.deepEqual((await copy.handoffReadiness(envOf(production(fresh())),{now:NOW})).blockers,today,label+': the blockers are unchanged');
 }
 // a flag-looking edit in the data (a `wired` field) changes nothing: wiring is derived from the receipts registry only
 const flagged=await load(text.replace("site:'epgSync commit (worker.js)',","site:'epgSync commit (worker.js)',wired:true,"),'flag.mjs');
 assert.deepEqual((await flagged.handoffReadiness(envOf(production(fresh())),{now:NOW})).blockers,today,'a wired flag has no effect');
 // only registering a real atomic operation changes it: film_mutation clears discovery_admission and the protocol
 const flipped=await load(text.replace("export const PRODUCER_OPERATIONS=operationRegistry([]);","export const PRODUCER_OPERATIONS=operationRegistry([{operation:'film_mutation',readback(){return null;},replay(){return {revision:1};},atomic:true}]);"),'flip.mjs');
 const after=(await flipped.handoffReadiness(envOf(production(fresh())),{now:NOW})).blockers;
 assert.deepEqual(today.filter(item=>!after.includes(item)),['receipts_protocol_unregistered','producer_not_wired:discovery_admission'],'registering an operation flips exactly its blockers');
}

// 6. The registries agree with the repository: a producer marked wired needs the Worker bundle to carry the adapters; receipts registered need the migration; nothing is
// bundled today; only the producers module imports the registry.
if(on('6')){
 const bundle=fs.readFileSync('build.mjs','utf8')+(fs.existsSync('scripts/bundle-scope.mjs')?fs.readFileSync('scripts/bundle-scope.mjs','utf8'):'');
 const bundled=/canonical-producers/.test(bundle);
 if(PRODUCER_OPERATIONS.size>0)assert.ok(bundled,'an operation is registered but the Worker bundle does not carry the producers module');
 else assert.ok(!bundled,'no operation is registered: the producers module is not bundled');
 const migrations=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name));
 const introduced=migrations.some(name=>fs.readFileSync('migrations/'+name,'utf8').includes(RECEIPTS_PROTOCOL.table));
 assert.ok(introduced,'migration 0019 exists in the repository (it is NOT applied in production, schema 18)');
 for(const item of PRODUCER_WIRING)for(const kind of item.requires)assert.ok(OPERATION_KINDS.includes(kind),kind+' is a receipts operation kind');
 assert.ok(!/canonical-differential-registry/.test(bundle));
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('canonical-differential-registry'))importers.push(full.replace(/\\/g,'/'));}};
 walk('src');
 assert.deepEqual(importers,['src/canonical-producers.js'],'only the producers module imports the differential registry');
 assert.equal(fs.readFileSync('src/canonical-differential-registry.js','utf8').split('\n').filter(line=>/^import /.test(line)).length,0,'the registry is data and imports nothing');
 for(const item of READER_REGISTRY)assert.equal(typeof item.moved,'boolean');
 assert.ok(Object.isFrozen(PRODUCER_WIRING)&&Object.isFrozen(READER_REGISTRY)&&Object.isFrozen(RECEIPTS_PROTOCOL)&&Object.isFrozen(EMPTY_CLASSES)&&Object.isFrozen(DIFFERENTIAL_COVERAGE));
}

console.log('canonical-handoff-readiness: computed readiness is not ready today ('+(fs.existsSync(path.join(root,'today.json'))?JSON.parse(fs.readFileSync(path.join(root,'today.json'),'utf8')).length:'n/a')+' blockers: receipts, producer wiring, readers, loaded classes, unaccepted named differences), ready in a fully satisfied synthetic fixture, every blocker flips independently, read-only, registries are data and agree with the repository');
