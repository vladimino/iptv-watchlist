// AIR-639 / ADR 0215 (Accepted), card ER: migration 0044 (a file only) and the manifest-bound reconstruction import path (src/identity-evidence-import.js), on the sqlite3-CLI D1
// stand-in. No Worker, R2, network or production access.
// Covered (ADR 0215 Tables 6 and 10, decision 7): the migration's refusal and replay; the immutable staging and the atomic seal (tampering before and after the seal, a late
// load, a post-seal insert, counts); the dry run (digest, duplicates, conflicts with `source_order`, bounds, R2 eligibility); the digest bound to the GO; the chunk batch (guards for
// a changed or deleted listed record, out-of-cohort additions, concurrent live insert, collision rolling the chunk back with no receipt, the four counts adding up, lost responses,
// stale-lease resume, two runs, the R2 ETag, the pending writer) and the dormant wiring.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {evidenceKeyOf,normalizeEvidence} from '../src/identity-evidence.js';
import {changeWriter} from '../src/identity-evidence-writer.js';
import * as Import from '../src/identity-evidence-import.js';

const {planManifest,validateManifest,loadManifest,sealRun,loadAndSealManifest,importRun,stopImportRun,readImportRun,readImportReport,readStagedManifest,manifestDigest,chunkStatements,guardCondition,identityEvidenceImportStatus,GUARD_TABLES}=Import;

const NEW='0044_identity_evidence_reconstruction_import.sql',PREVIOUS='0043_film_redirect_by_target.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.ok(files.includes(NEW),'0044 exists');
assert.equal(files[files.indexOf(NEW)-1],PREVIOUS,'0044 follows 0043');
const chain=files.slice(0,files.indexOf(NEW));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-identity-import-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern,text);};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const lit=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";

const templatePrev=path.join(root,'tprev.sqlite'),template=path.join(root,'tnew.sqlite');
ok(templatePrev,chain.map(read).join('\n'));
fs.copyFileSync(templatePrev,template);
ok(template,read(NEW));
let n=0;
const copy=source=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const BASE=Date.parse('2026-11-25T10:00:00.000Z');
const at=ms=>new Date(BASE+ms).toISOString();
const COHORT=at(0);
const SEEN='2026-11-01T00:00:00.000Z';

// ---- fixtures: Discovery history rows as the sources, and the evidence a family would map them to ----
const OBS=i=>'film '+i+'|2000';
const seed=(file,i,revision=1,payload='{"identitySource":"tmdb_detail"}')=>ok(file,"INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ("+lit(OBS(i))+","+revision+",1,"+lit(SEEN)+",'w',"+lit(payload)+")");
const source=(i,revision=1)=>({kind:'d1_row',table:'discovery_decision_history',key:{observation_key:OBS(i),revision},guard:{written_at:SEEN,'payload_json#$.identitySource':'tmdb_detail'}});
const evidence=(i,over={})=>({subject:{kind:'discovery_observation',value:OBS(i)},relation:'candidate_for',object:{kind:'tmdb_movie',value:String(100+i)},polarity:'asserts',route:'discovery_scan',method:'tmdb_detail_check',sourceRoot:OBS(i),observedAt:SEEN,...over});
const record=(i,{revision=1,over={}}={})=>({source:source(i,revision),rows:[{evidence:evidence(i,over)}]});
const records=(count,from=1)=>Array.from({length:count},(_,index)=>record(from+index));
const seedAll=(file,count,from=1)=>{for(let i=from;i<from+count;i++)seed(file,i);};
// Family `a` needs no live writer; the run still NAMES the two Discovery writers so a `pending` state refuses it. Family `b` (which needs both `on`) has its own section.
const OPTIONS={runId:'run-1',family:'a',cohortAt:COHORT,writers:['discovery_decision','discovery_owner']};
const plan=(list,over={})=>planManifest({...OPTIONS,records:list,...over});
const ledger=file=>rows(file,'SELECT evidence_key,origin,reconstruction_run,reconstructed_from,request_id,source_order,film_id FROM film_identity_evidence ORDER BY seq');
const envOf=file=>({DB:d1Standin(file)});
// A database whose batches can be observed, failed before they run or answered with a lost response after they commit.
const flaky=(file,{before,after}={})=>{
 const db=d1Standin(file);const batch=db.batch.bind(db);
 return {...db,prepare:db.prepare.bind(db),batch:async list=>{const texts=list.map(item=>item.text);if(before)await before(texts);const out=await batch(list);if(after)await after(texts);return out;}};
};
const isReceipt=texts=>texts.some(text=>text.startsWith('INSERT INTO identity_evidence_import_receipt'));
const staged=async(file,list,over={})=>{
 const env=envOf(file);const result=await plan(list,over);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 return {env,...result};
};
const run=(env,digest,over={})=>importRun(env,{runId:over.runId||'run-1',approvedDigest:digest,owner:'operator-a',now:at(2000),...over});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const key=async input=>evidenceKeyOf(normalizeEvidence({origin:'live',...input}));

// ===== 1. the migration: it follows a complete 42, creates nothing otherwise and leaves the ledger and every other object untouched =====
{
 const objects=file=>one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','trigger','index')");
 const t42=path.join(root,'t42.sqlite');
 ok(t42,chain.slice(0,-1).map(read).join('\n'));
 const before=objects(t42);
 refused(t42,read(NEW));
 assert.equal(objects(t42),before,'a refused file creates nothing (schema 42, 0043 missing)');
 const damaged=copy(templatePrev);
 ok(damaged,'DROP TRIGGER identity_evidence_writer_update');
 const beforeDamaged=objects(damaged);
 refused(damaged,read(NEW));
 assert.equal(objects(damaged),beforeDamaged,'a refused file creates nothing (43 without a 0042 trigger)');
 refused(template,read(NEW),/UNIQUE|PRIMARY/);
 // The redirect index of 0043 is part of a complete 43.
 const noIndex=copy(templatePrev);ok(noIndex,'DROP INDEX film_redirect_by_target');refused(noIndex,read(NEW));
 assert.equal(one(template,'SELECT version FROM schema_contract WHERE id=1'),44);
 assert.equal(one(template,'SELECT COUNT(*) FROM schema_contract'),1);
 for(const table of ['run','chunk','source','row','seal','receipt'])assert.equal(one(template,'SELECT COUNT(*) FROM identity_evidence_import_'+table),0,table+' starts empty');
 assert.equal(one(template,'SELECT COUNT(*) FROM film_identity_evidence'),0,'the ledger is untouched');
 const names=file=>rows(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").map(row=>row.type+':'+row.name).sort();
 const added=names(template).filter(name=>!names(templatePrev).includes(name));
 assert.ok(added.length>0&&added.every(name=>/identity_evidence_import|sqlite_autoindex/.test(name)),'only import objects are added: '+added.filter(name=>!/identity_evidence_import/.test(name)));
 assert.deepEqual(names(templatePrev).filter(name=>!names(template).includes(name)),[],'0044 removes no object');
 assert.equal(await identityEvidenceImportStatus(envOf(template)),'ready');
 assert.equal(await identityEvidenceImportStatus(envOf(templatePrev)),'absent');
 const downgrade=copy(template);
 refused(downgrade,'UPDATE schema_contract SET version=43 WHERE id=1',/schema_contract_downgrade/);
 // Version 43 with an import table missing is a damaged schema, never "no run".
 const missing=copy(template);
 ok(missing,'DROP TABLE identity_evidence_import_receipt');
 await assert.rejects(()=>identityEvidenceImportStatus(envOf(missing)),code('identity_evidence_import_unavailable'));
 // Absent tables: every operator refuses, nothing is read as "no run".
 await assert.rejects(()=>readImportRun(envOf(templatePrev),'run-1'),code('identity_evidence_import_unavailable'));
}

// ===== 2. the dry run: manifest, digest, duplicates, conflicts, bounds, R2 =====
{
 const first=await plan(records(3));
 const again=await plan(records(3));
 assert.equal(first.digest,again.digest,'the digest is deterministic');
 assert.match(first.digest,/^[0-9a-f]{64}$/);
 assert.equal(first.digest,await manifestDigest(first.manifest));
 assert.deepEqual(first.report.counts,{chunks:1,sources:3,rows:3});
 assert.notEqual((await plan([...records(3)].reverse())).digest,first.digest,'the manifest order is part of the digest');
 assert.notEqual((await plan(records(3),{cohortAt:at(5)})).digest,first.digest,'the cohort time is part of the digest');
 assert.notEqual((await plan(records(3),{runId:'run-2'})).digest,first.digest,'the run is part of the digest');
 // Every row is a reconstruction row with the token of its source record and the key of the ledger's own formula.
 const row=first.manifest.chunks[0].rows[0];
 assert.equal(row.key,await key(evidence(1)),'the key is the live key of the same proposition (ADR 0215 decision 7: the same mapping)');
 assert.match(row.reconstructedFrom,/^d1:discovery_decision_history:[0-9a-f]{64}$/);
 // Two sources mapping to one key: the first in manifest order owns it; the other is a reported duplicate and, with no row left, is excluded.
 const dup=await plan([record(1),record(1,{revision:2})]);
 assert.deepEqual(dup.report.counts,{chunks:1,sources:1,rows:1});
 assert.equal(dup.report.duplicates.length,1);
 assert.equal(dup.report.duplicates[0].owner,dup.manifest.chunks[0].sources[0].token);
 assert.ok(dup.report.excluded.some(item=>item.reason==='no_rows_after_keys'));
 // The same source twice with the same descriptor is ONE record: its rows merge, and an identical mapping is a reported duplicate (never a silent drop).
 const twice=await plan([record(1),record(1)]);
 assert.deepEqual(twice.report.counts,{chunks:1,sources:1,rows:1});
 assert.equal(twice.report.duplicates.length,1);assert.deepEqual(twice.report.excluded,[]);
 // Duplicate inputs that disagree on `source_order` are a reported conflict and the key is left out (ADR 0215 decision 7, step 3).
 const owner=order=>({subject:{kind:'discovery_observation',value:OBS(9)},relation:'candidate_for',object:{kind:'tmdb_movie',value:'109'},polarity:'asserts',route:'owner_action',method:'owner_statement',sourceRoot:'intent-9',observedAt:SEEN,sourceOrder:order});
 const conflict=await plan([{source:source(9,1),rows:[{evidence:owner(1)}]},{source:source(9,2),rows:[{evidence:owner(2)}]},record(1)]);
 assert.equal(conflict.report.conflicts.length,1);
 assert.deepEqual(conflict.report.counts,{chunks:1,sources:1,rows:1},'both disagreeing inputs are left out');
 // Agreeing inputs (same order) are duplicates, not a conflict.
 const agree=await plan([{source:source(9,1),rows:[{evidence:owner(2)}]},{source:source(9,2),rows:[{evidence:owner(2)}]}]);
 assert.equal(agree.report.conflicts.length,0);assert.equal(agree.report.duplicates.length,1);
 // A rootless reconstructed row keys on its source record: two records stay two rows.
 const rootless=over=>({sourceRoot:null,...over});
 const two=await plan([record(1,{over:rootless()}),record(1,{revision:2,over:rootless()})]);
 assert.deepEqual(two.report.counts,{chunks:1,sources:2,rows:2});
 // Bounds: at most 50 source records and 200 rows per chunk, ordered chunks with consecutive numbers.
 const big=await plan(records(120));
 assert.deepEqual(big.manifest.chunks.map(chunk=>chunk.chunkNo),[1,2,3]);
 assert.deepEqual(big.manifest.chunks.map(chunk=>chunk.sources.length),[50,50,20]);
 const multi=Array.from({length:30},(_,index)=>({source:source(index+1),rows:Array.from({length:3},(_,k)=>({evidence:evidence(index+1,{object:{kind:'tmdb_movie',value:String(500+index*3+k)}})}))}));
 const byRows=await plan(multi);
 assert.ok(byRows.manifest.chunks.every(chunk=>chunk.rows.length<=200&&chunk.sources.length<=50),'a chunk holds at most 200 rows');
 assert.equal(byRows.manifest.chunks.reduce((sum,chunk)=>sum+chunk.rows.length,0),90);
 const tooLarge=await plan([{source:source(1),rows:Array.from({length:201},(_,k)=>({evidence:evidence(1,{object:{kind:'tmdb_movie',value:String(1000+k)}})}))},record(2)]);
 assert.deepEqual(tooLarge.report.excluded.map(item=>item.reason),['record_too_large']);
 // R2 objects: eligible only when frozen by contract and with the residual window accepted; the pinned ETag is in the manifest and the window in the report.
 const r2=(over={})=>({source:{kind:'r2_object',key:'admin/actions/discovery_identity_correct/v1/a.json',record:'whole',etag:'etag-1',r2:'admin_action_applied',residualAccepted:true,...over},rows:[{evidence:evidence(1)}]});
 const withR2=await plan([r2()]);
 assert.equal(withR2.manifest.chunks[0].sources[0].etag,'etag-1');
 assert.equal(withR2.report.r2Residual.length,1);assert.match(withR2.report.r2Residual[0].window,/ETag re-read/);assert.deepEqual(withR2.report.r2Residual[0].chunks,[1]);
 assert.deepEqual((await plan([r2({residualAccepted:false}),record(2)])).report.excluded.map(item=>item.reason),['r2_residual_not_accepted']);
 assert.deepEqual((await plan([r2({r2:'admin_action_pending'}),record(2)])).report.excluded.map(item=>item.reason),['r2_not_frozen']);
 // Refused inputs.
 await assert.rejects(()=>plan(null),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:{...source(1),table:'film'},rows:[{evidence:evidence(1)}]}]),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:{...source(1),guard:{'written_at#$.x':1}},rows:[{evidence:evidence(1)}]}]),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:{...source(1),guard:{payload_json:true}},rows:[{evidence:evidence(1)}]}]),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:{...source(1),guard:{'payload_json#$.a;DROP':'x'}},rows:[{evidence:evidence(1)}]}]),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:{...source(1),guard:{secret_column:'x'}},rows:[{evidence:evidence(1)}]}]),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:{...source(1),key:{observation_key:OBS(1)}},rows:[{evidence:evidence(1)}]}]),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan(records(1),{writers:['nobody']}),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan(records(1),{family:'z'}),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan([{source:source(1),rows:[{evidence:evidence(1,{polarity:'refutes',method:'tmdb_detail_check'})}]}]),code('identity_evidence_invalid'));
 for(const table of Object.keys(GUARD_TABLES))assert.ok(GUARD_TABLES[table].key.every(column=>GUARD_TABLES[table].columns.includes(column)),table+' key columns are guardable');
 // The guard SQL comes from the allowlist and binds every value.
 const condition=guardCondition(source(1));
 assert.equal((condition.sql.match(/\?/g)||[]).length,condition.params.length);
 assert.ok(!condition.sql.includes(OBS(1)),'no value is inlined');
}

// ===== 3. load, digest bound to the GO, the atomic seal, tampering before and after it =====
{
 const file=copy(template);seedAll(file,5);
 const env=envOf(file);
 const {manifest,digest}=await plan(records(5));
 // A hand-edited manifest never reaches the staging tables.
 const edited=JSON.parse(JSON.stringify(manifest));edited.chunks[0].rows[0].subjectValue='film 99|2000';
 await assert.rejects(()=>loadManifest(env,{manifest:edited,approvedDigest:digest}),code('identity_evidence_import_invalid'));
 const badToken=JSON.parse(JSON.stringify(manifest));badToken.chunks[0].sources[0].token='d1:discovery_decision_history:'+'0'.repeat(64);badToken.chunks[0].rows[0].reconstructedFrom=badToken.chunks[0].sources[0].token;
 await assert.rejects(()=>loadManifest(env,{manifest:badToken,approvedDigest:digest}),code('identity_evidence_import_invalid'));
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_run'),0,'nothing is staged by a refused manifest');
 // A digest that is not the approved one: nothing is staged.
 await assert.rejects(()=>loadManifest(env,{manifest,approvedDigest:'0'.repeat(64)}),code('identity_evidence_import_digest_mismatch'));
 await assert.rejects(()=>loadManifest(env,{manifest,approvedDigest:undefined}),code('identity_evidence_import_digest_mismatch'));
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_run'),0);
 // Load reads the staging back and recomputes the digest, and an interrupted load is resumed chunk by chunk.
 const loaded=await loadManifest(env,{manifest,approvedDigest:digest,now:at(10)});
 assert.deepEqual({chunks:loaded.chunks,sources:loaded.sources,rows:loaded.rows,state:loaded.state},{chunks:1,sources:5,rows:5,state:'staging'});
 assert.equal(await manifestDigest(await readStagedManifest(env,'run-1')),digest,'the staging reads back to the approved digest');
 assert.equal((await loadManifest(env,{manifest,approvedDigest:digest,now:at(11)})).rows,5,'a repeated load is idempotent');
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_row'),5);
 await assert.rejects(()=>sealRun(env,{runId:'run-1',approvedDigest:'f'.repeat(64)}),code('identity_evidence_import_staging_mismatch'));
 assert.equal((await readImportRun(env,'run-1')).stopReason,'staging_mismatch','a staging that does not match the approved digest abandons the run');
}
{
 // The seal: one atomic step; a second seal, a post-seal insert and every update and delete are refused by the database.
 const file=copy(template);seedAll(file,3);
 const {env,digest,manifest}=await staged(file,records(3));
 const run=await readImportRun(env,'run-1');
 assert.equal(run.state,'sealed');assert.equal(run.attempt,0);
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_seal'),1);
 assert.deepEqual((await sealRun(env,{runId:'run-1',approvedDigest:digest})).sealed,false,'sealing again is a no-op');
 const row=manifest.chunks[0].rows[0];
 const insertRow=(chunk,ordinal,keyHex)=>"INSERT INTO identity_evidence_import_row (run_id,chunk_no,ordinal,source_ordinal,evidence_key,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,reconstructed_from) VALUES ('run-1',"+chunk+","+ordinal+",1,'"+keyHex+"','discovery_observation','x|1','candidate_for','tmdb_movie','1','asserts','discovery_scan','tmdb_detail_check','x|1',"+lit(SEEN)+","+lit(row.reconstructedFrom)+")";
 refused(file,insertRow(1,50,'a'.repeat(64)),/identity_evidence_import_sealed/);
 refused(file,"INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES ('run-1',2,1,1)",/identity_evidence_import_sealed/);
 refused(file,"INSERT INTO identity_evidence_import_source (run_id,chunk_no,ordinal,kind,source_table,source_key,guard_json,source_token) VALUES ('run-1',1,9,'d1_row','discovery_decision_history','{}','{}','t')",/identity_evidence_import_sealed/);
 refused(file,"INSERT INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES ('run-1','"+digest+"',1,3,3,"+lit(at(0))+")",/identity_evidence_import_(sealed|seal_mismatch)/);
 for(const table of ['chunk','source','row','seal'])refused(file,'DELETE FROM identity_evidence_import_'+table,/identity_evidence_import_immutable/);
 refused(file,"UPDATE identity_evidence_import_row SET subject_value='y'",/identity_evidence_import_immutable/);
 refused(file,"UPDATE identity_evidence_import_chunk SET row_count=1",/identity_evidence_import_immutable/);
 refused(file,"UPDATE identity_evidence_import_source SET source_key='{}'",/identity_evidence_import_immutable/);
 refused(file,"UPDATE identity_evidence_import_seal SET row_count=1",/identity_evidence_import_immutable/);
 refused(file,'DELETE FROM identity_evidence_import_run',/identity_evidence_import_immutable/);
 // INSERT OR REPLACE would delete a conflicting row without a DELETE trigger: the conflict guards refuse it first.
 refused(file,"INSERT OR REPLACE INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES ('run-1','"+digest+"',1,3,3,"+lit(at(0))+")",/identity_evidence_import_(sealed|seal_mismatch)/);
 refused(file,"INSERT OR REPLACE INTO identity_evidence_import_run (run_id,family,manifest_sha256,cohort_at,chunk_count,source_count,row_count,writers_json,state,attempt,created_at,updated_at) VALUES ('run-1','b','"+digest+"',"+lit(COHORT)+",1,3,3,'[]','staging',0,"+lit(COHORT)+","+lit(COHORT)+")",/identity_evidence_import_run_taken/);
 // The run's identity and digest never change, and no state moves outside the machine.
 for(const set of ["manifest_sha256='"+'0'.repeat(64)+"'","family='a'","row_count=9","cohort_at='2026-11-26T00:00:00.000Z'","writers_json='[]'","state='complete'","state='staging'","state='running',attempt=2,lease_owner='x',lease_expires_at='2099-01-01T00:00:00.000Z'","state='running',attempt=1,lease_owner='x',lease_expires_at='2000-01-01T00:00:00.000Z'"])
  refused(file,"UPDATE identity_evidence_import_run SET "+set+",updated_at='2026-11-25T11:00:00.000Z'",/identity_evidence_import_run_transition|CHECK constraint failed/);
}
{
 // A seal with counts that do not equal the staged ones is refused by the trigger, per chunk and in total; a source without a row is refused.
 const file=copy(template);seedAll(file,2);
 const env=envOf(file);const {manifest,digest}=await plan(records(2));
 await loadManifest(env,{manifest,approvedDigest:digest,now:at(10)});
 refused(file,"INSERT INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES ('run-1','"+digest+"',1,2,3,"+lit(at(20))+")",/identity_evidence_import_seal_mismatch/);
 refused(file,"INSERT INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES ('run-1','"+'1'.repeat(64)+"',1,2,2,"+lit(at(20))+")",/identity_evidence_import_seal_mismatch/);
 assert.equal(one(file,'SELECT state FROM identity_evidence_import_run'),'staging','a refused seal changes nothing');
 // A source whose row was never staged cannot be sealed.
 const lonely=copy(template);seedAll(lonely,2);
 const lonelyEnv=envOf(lonely);
 await lonelyEnv.DB.batch([lonelyEnv.DB.prepare('INSERT INTO identity_evidence_import_run (run_id,family,manifest_sha256,cohort_at,chunk_count,source_count,row_count,writers_json,state,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind('run-x','b',digest,COHORT,1,1,1,'[]','staging',0,COHORT,COHORT)]);
 ok(lonely,"INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES ('run-x',1,1,1);INSERT INTO identity_evidence_import_source (run_id,chunk_no,ordinal,kind,source_table,source_key,guard_json,source_token) VALUES ('run-x',1,1,'d1_row','discovery_decision_history','{}','{}','tok')");
 refused(lonely,"INSERT INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES ('run-x','"+digest+"',1,1,1,"+lit(at(20))+")",/identity_evidence_import_seal_mismatch/);
 // The bounds are in the schema too: 51 sources or 201 rows in a chunk.
 refused(lonely,"INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES ('run-x',2,51,1)",/CHECK constraint failed/);
 refused(lonely,"INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES ('run-x',2,1,201)",/CHECK constraint failed/);
 // A row must carry its own source's token, and a key appears once per run.
 refused(lonely,"INSERT INTO identity_evidence_import_row (run_id,chunk_no,ordinal,source_ordinal,evidence_key,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,reconstructed_from) VALUES ('run-x',1,1,1,'"+'a'.repeat(64)+"','discovery_observation','x|1','candidate_for','tmdb_movie','1','asserts','discovery_scan','tmdb_detail_check','x|1',"+lit(SEEN)+",'other')",/identity_evidence_import_row_source/);
 ok(lonely,"INSERT INTO identity_evidence_import_row (run_id,chunk_no,ordinal,source_ordinal,evidence_key,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,reconstructed_from) VALUES ('run-x',1,1,1,'"+'a'.repeat(64)+"','discovery_observation','x|1','candidate_for','tmdb_movie','1','asserts','discovery_scan','tmdb_detail_check','x|1',"+lit(SEEN)+",'tok')");
 refused(lonely,"INSERT INTO identity_evidence_import_row (run_id,chunk_no,ordinal,source_ordinal,evidence_key,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,reconstructed_from) VALUES ('run-x',1,2,1,'"+'a'.repeat(64)+"','discovery_observation','x|1','candidate_for','tmdb_movie','1','asserts','discovery_scan','tmdb_detail_check','x|1',"+lit(SEEN)+",'tok')",/identity_evidence_import_sealed|UNIQUE/);
}
{
 // Tampering BEFORE the seal (a bypass of the triggers): the readback recomputes the digest and abandons the run.
 const file=copy(template);seedAll(file,3);
 const env=envOf(file);const {manifest,digest}=await plan(records(3));
 await loadManifest(env,{manifest,approvedDigest:digest,now:at(10)});
 ok(file,"DROP TRIGGER identity_evidence_import_row_no_update;UPDATE identity_evidence_import_row SET object_value='999' WHERE ordinal=1");
 await assert.rejects(()=>sealRun(env,{runId:'run-1',approvedDigest:digest,now:at(20)}),code('identity_evidence_import_staging_mismatch'));
 const stopped=await readImportRun(env,'run-1');
 assert.deepEqual([stopped.state,stopped.stopReason],['stopped','staging_mismatch']);
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_seal'),0,'a tampered staging is never sealed');
 await assert.rejects(()=>importRun(env,{runId:'run-1',approvedDigest:digest,owner:'op',now:at(30)}),code('identity_evidence_import_stopped'));
}
{
 // Tampering AFTER the seal: no chunk runs; the claim reads the staging back first.
 for(const tamper of ["UPDATE identity_evidence_import_row SET object_value='999' WHERE ordinal=1","DELETE FROM identity_evidence_import_row WHERE ordinal=2","UPDATE identity_evidence_import_source SET guard_json='{\"written_at\":\"x\"}' WHERE ordinal=1"]){
  const file=copy(template);seedAll(file,3);
  const {env,digest}=await staged(file,records(3));
  ok(file,'DROP TRIGGER identity_evidence_import_row_no_update;DROP TRIGGER identity_evidence_import_row_no_delete;DROP TRIGGER identity_evidence_import_source_no_update;'+tamper);
  await assert.rejects(()=>run(env,digest),code('identity_evidence_import_staging_mismatch'),tamper);
  assert.deepEqual(ledger(file),[],'nothing is imported from a tampered staging: '+tamper);
  assert.equal((await readImportRun(env,'run-1')).stopReason,'staging_mismatch');
 }
}
{
 // A seal racing a late load: whatever the interleaving, a sealed run holds exactly the manifest, and a load after the seal is refused.
 const file=copy(template);seedAll(file,60);
 const env=envOf(file);const {manifest,digest}=await plan(records(60));
 assert.equal(manifest.chunks.length,2);
 const first=await Promise.allSettled([loadManifest(env,{manifest,approvedDigest:digest,now:at(10)}),new Promise(resolve=>setTimeout(resolve,0)).then(()=>sealRun(env,{runId:'run-1',approvedDigest:digest,now:at(11)}))]);
 const sealed=one(file,'SELECT COUNT(*) FROM identity_evidence_import_seal');
 if(sealed===1){
  assert.equal(await manifestDigest(await readStagedManifest(env,'run-1')),digest,'a sealed run holds exactly the approved manifest');
  assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_row'),60);
 }else assert.equal((await readImportRun(env,'run-1')).state==='sealed',false);
 assert.ok(first.some(item=>item.status==='fulfilled'));
 const second=copy(template);seedAll(second,60);
 const secondEnv=envOf(second);
 await loadManifest(secondEnv,{manifest,approvedDigest:digest,now:at(10)});
 await sealRun(secondEnv,{runId:'run-1',approvedDigest:digest,now:at(11)});
 refused(second,"INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES ('run-1',3,1,1)",/identity_evidence_import_sealed/);
 await assert.rejects(()=>loadManifest(secondEnv,{manifest,approvedDigest:digest,now:at(12)}),code('identity_evidence_import_sealed'));
}

// ===== 4. the import: the four outcomes, the receipt, and what the batch never touches =====
{
 const file=copy(template);seedAll(file,130);
 const before=name=>one(file,'SELECT COUNT(*) FROM '+name);
 const guarded=['film','canonical_revision','canonical_write_receipt','discovery_decision_history','film_external_id'].map(name=>[name,before(name)]);
 const {env,digest,manifest}=await staged(file,records(130));
 assert.equal(manifest.chunks.length,3);
 const result=await run(env,digest);
 assert.equal(result.state,'complete');assert.equal(result.done,true);
 assert.equal(result.chunks.length,3);
 assert.deepEqual(result.totals,{stagedKeys:130,inserted:130,alreadyImported:0,liveCovered:0,reconstructedEquivalent:0});
 for(const receipt of result.chunks)assert.equal(receipt.inserted+receipt.alreadyImported+receipt.liveCovered+receipt.reconstructedEquivalent,receipt.stagedKeys,'the four counts add up to the staged keys');
 const written=ledger(file);
 assert.equal(written.length,130);
 assert.ok(written.every(row=>row.origin==='reconstruction'&&row.reconstruction_run==='run-1'&&row.film_id===null&&/^d1:discovery_decision_history:/.test(row.reconstructed_from)&&/^reconstruction:run-1:[123]$/.test(row.request_id)));
 assert.deepEqual(written.slice(0,3).map(row=>row.evidence_key),manifest.chunks[0].rows.slice(0,3).map(row=>row.key),'rows land in manifest order');
 for(const [name,count] of guarded)assert.equal(before(name),count,name+' is untouched: no Film revision, no canonical receipt, no source row moves');
 assert.deepEqual(rows(file,'SELECT chunk_no,attempt FROM identity_evidence_import_receipt ORDER BY chunk_no'),[{chunk_no:1,attempt:1},{chunk_no:2,attempt:1},{chunk_no:3,attempt:1}]);
 // Complete is terminal; a second import of the same run is a read.
 assert.equal((await run(env,digest,{now:at(9000)})).state,'complete');
 assert.equal(ledger(file).length,130,'a finished run writes nothing more');
 // A wrong approved digest claims nothing.
 await assert.rejects(()=>run(env,'0'.repeat(64)),code('identity_evidence_import_digest_mismatch'));
 refused(file,"UPDATE identity_evidence_import_receipt SET inserted=0",/identity_evidence_import_immutable/);
 refused(file,"DELETE FROM identity_evidence_import_receipt",/identity_evidence_import_immutable/);
 assert.equal((await readImportReport(env,'run-1')).totals.inserted,130);
}
{
 // Statement budgets of a full chunk: 50 sources (one assertion each) inside D1's 2,000 statements per batch and 100 binds per statement.
 const file=copy(template);seedAll(file,50);
 const {env,manifest}=await staged(file,records(50));
 const chunk=await readStagedManifest(env,'run-1').then(m=>m.chunks[0]);
 const statements=chunkStatements({run:{runId:'run-1',manifestSha256:'a'.repeat(64)},chunk,attempt:1,at:at(1)});
 assert.equal(statements.length,2+50+3,'two fence assertions, one per source, then the insert, the identity assertion and the receipt');
 for(const [sql,params] of statements){assert.ok(params.length<100,'binds per statement: '+params.length);assert.equal((sql.match(/\?/g)||[]).length,params.length);}
 assert.equal(manifest.chunks[0].sources.length,50);
 // The rows are inserted from the staging, never from caller values: the insert binds only the request id, the time, the run and the chunk.
 const insert=statements.find(([sql])=>sql.startsWith('INSERT INTO film_identity_evidence'));
 assert.deepEqual(insert[1],['reconstruction:run-1:1',at(1),'run-1',1]);
}
{
 // reconstructed_equivalent and already_imported: another source record of the same proposition, and a replay of the same record, by later runs with their own cohorts.
 const file=copy(template);seedAll(file,3);seed(file,1,2);seed(file,2,2);
 const first=await staged(file,records(3));
 await run(first.env,first.digest);
 const replay=await staged(file,records(3),{runId:'run-2'});
 const replayed=await run(replay.env,replay.digest,{runId:'run-2'});
 assert.deepEqual(replayed.totals,{stagedKeys:3,inserted:0,alreadyImported:3,liveCovered:0,reconstructedEquivalent:0},'a replay of the same reconstructed record is idempotent and not counted as corroboration');
 const other=await staged(file,[record(1,{revision:2}),record(2,{revision:2}),record(3)],{runId:'run-3'});
 const mixed=await run(other.env,other.digest,{runId:'run-3'});
 assert.deepEqual(mixed.totals,{stagedKeys:3,inserted:0,alreadyImported:1,liveCovered:0,reconstructedEquivalent:2},'a different source record of the same semantic identity is reconstructed_equivalent');
 assert.equal(ledger(file).length,3,'no key is written twice');
 const report=await readImportReport(other.env,'run-3');
 assert.equal(report.equivalents.length,2,'reported with both source records');
 assert.ok(report.equivalents.every(item=>item.existingRun==='run-1'&&item.stagedFrom!==item.existingFrom));
 // A rootless record is keyed by its source: a replay is already_imported, never covered by anything else.
 const rootless=records(1).map(item=>({...item,rows:[{evidence:{...item.rows[0].evidence,sourceRoot:null,observedAt:null}}]}));
 const a=await staged(file,rootless,{runId:'run-4'});
 assert.equal((await run(a.env,a.digest,{runId:'run-4'})).totals.inserted,1);
 const b=await staged(file,rootless,{runId:'run-5'});
 assert.equal((await run(b.env,b.digest,{runId:'run-5'})).totals.alreadyImported,1);
 assert.equal(ledger(file).length,4);
}
{
 // live_covered: a live row of the same key and identity written before the chunk. A live row never covers a record with a different root (a different key).
 const file=copy(template);seedAll(file,3);
 const liveInput=i=>({...evidence(i)});
 const live=await key(liveInput(2));
 ok(file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at) VALUES ('"+live+"',NULL,'discovery_observation',"+lit(OBS(2))+",'candidate_for','tmdb_movie','102','asserts','discovery_scan','tmdb_detail_check',"+lit(OBS(2))+","+lit(SEEN)+",'live','live-req',"+lit(SEEN)+")");
 const {env,digest}=await staged(file,records(3));
 const result=await run(env,digest);
 assert.deepEqual(result.totals,{stagedKeys:3,inserted:2,alreadyImported:0,liveCovered:1,reconstructedEquivalent:0});
 assert.equal(ledger(file).length,3);
 assert.equal(ledger(file).find(row=>row.evidence_key===live).origin,'live','the live row is kept as it was');
 // A concurrent live insert of the same key between the claim and the chunk: the batch sees it and counts it as live_covered, with no duplicate.
 const racing=copy(template);seedAll(racing,2);
 const raced=await plan(records(2));
 const db=flaky(racing,{before:async texts=>{if(isReceipt(texts)&&one(racing,'SELECT COUNT(*) FROM film_identity_evidence')===0)ok(racing,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at) VALUES ('"+live+"',NULL,'discovery_observation',"+lit(OBS(2))+",'candidate_for','tmdb_movie','102','asserts','discovery_scan','tmdb_detail_check',"+lit(OBS(2))+","+lit(SEEN)+",'live','live-req',"+lit(SEEN)+")");}});
 const racingEnv={DB:db};
 await loadAndSealManifest(racingEnv,{manifest:raced.manifest,approvedDigest:raced.digest,now:at(10)});
 const racedResult=await run(racingEnv,raced.digest);
 assert.equal(racedResult.totals.inserted+racedResult.totals.liveCovered,2);
 assert.equal(ledger(racing).length,2);
}
{
 // A collision: the key exists with another `source_order` (or an unknown one). The whole chunk rolls back before any receipt and the run stops for owner review.
 const owner=(i,order)=>({subject:{kind:'discovery_observation',value:OBS(i)},relation:'candidate_for',object:{kind:'tmdb_movie',value:String(100+i)},polarity:'asserts',route:'owner_action',method:'owner_statement',sourceRoot:'intent-'+i,observedAt:SEEN,sourceOrder:order});
 for(const [stagedOrder,liveOrder] of [[5,3],[null,3],[3,null]]){
  const file=copy(template);seedAll(file,3);
  const clash=await key(owner(2,1));
  ok(file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at,source_order) VALUES ('"+clash+"',NULL,'discovery_observation',"+lit(OBS(2))+",'candidate_for','tmdb_movie','102','asserts','owner_action','owner_statement','intent-2',"+lit(SEEN)+",'live','live-req',"+lit(SEEN)+","+lit(liveOrder)+")");
  const list=[record(1),{source:source(2),rows:[{evidence:owner(2,stagedOrder===null?undefined:stagedOrder)}]},record(3)];
  const {env,digest}=await staged(file,list);
  await assert.rejects(()=>run(env,digest),code('identity_evidence_import_collision'),'staged '+stagedOrder+' vs live '+liveOrder);
  assert.equal(ledger(file).length,1,'the whole chunk rolled back: only the existing live row remains');
  assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),0,'no receipt');
  const stopped=await readImportRun(env,'run-1');
  assert.deepEqual([stopped.state,stopped.stopReason],['stopped','collision']);
  await assert.rejects(()=>run(env,digest,{now:at(99999)}),code('identity_evidence_import_stopped'));
 }
 // The same `source_order` is the same row: no collision (live_covered).
 const file=copy(template);seedAll(file,2);
 const same=await key(owner(2,3));
 ok(file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at,source_order) VALUES ('"+same+"',NULL,'discovery_observation',"+lit(OBS(2))+",'candidate_for','tmdb_movie','102','asserts','owner_action','owner_statement','intent-2',"+lit(SEEN)+",'live','live-req',"+lit(SEEN)+",3)");
 const {env,digest}=await staged(file,[record(1),{source:source(2),rows:[{evidence:owner(2,3)}]}]);
 assert.equal((await run(env,digest)).totals.liveCovered,1);
}

// ===== 5. the guards: a changed or deleted listed record, late arrivals =====
{
 // A listed record that changed or disappeared after the cohort fails ITS chunk as `source_moved` and stops the run; earlier chunks keep their receipts.
 for(const [name,mutate] of [['changed field',"UPDATE discovery_decision_history SET written_at='2026-11-02T00:00:00.000Z' WHERE observation_key='"+OBS(60)+"'"],
  ['changed json field',"UPDATE discovery_decision_history SET payload_json='{\"identitySource\":\"other\"}' WHERE observation_key='"+OBS(60)+"'"],
  ['deleted',"DELETE FROM discovery_decision_history WHERE observation_key='"+OBS(60)+"'"]]){
  const file=copy(template);seedAll(file,60);
  const {env,digest}=await staged(file,records(60));
  ok(file,mutate);
  await assert.rejects(()=>run(env,digest),code('identity_evidence_import_source_moved'),name);
  assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),1,name+': chunk 1 keeps its receipt');
  assert.equal(ledger(file).length,50,name+': chunk 2 wrote nothing');
  const stopped=await readImportRun(env,'run-1');
  assert.deepEqual([stopped.state,stopped.stopReason],['stopped','source_moved']);
  await assert.rejects(()=>run(env,digest,{now:at(99999)}),code('identity_evidence_import_stopped'),'the owner re-runs the dry run and gives a new GO');
 }
 // A change AFTER the chunk committed is not a failure: that chunk's guards held when it committed.
 const late=copy(template);seedAll(late,60);
 const {env,digest}=await staged(late,records(60));
 await run(env,digest,{maxChunks:1});
 ok(late,"UPDATE discovery_decision_history SET written_at='2026-11-03T00:00:00.000Z' WHERE observation_key='"+OBS(1)+"'");
 assert.equal((await run(env,digest,{now:at(3000)})).state,'complete');
}
{
 // Late and backdated arrivals are outside the cohort: not imported, and they do not stop the run.
 const file=copy(template);seedAll(file,3);
 const {env,digest}=await staged(file,records(3));
 ok(file,"INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ("+lit(OBS(4))+",1,1,'2026-10-01T00:00:00.000Z','w','{\"identitySource\":\"tmdb_detail\"}')");
 ok(file,"INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ("+lit(OBS(1))+",2,1,'2026-11-26T00:00:00.000Z','w','{\"identitySource\":\"tmdb_detail\"}')");
 const result=await run(env,digest);
 assert.equal(result.state,'complete');
 assert.equal(ledger(file).length,3,'only the listed cohort was imported');
}

// ===== 6. lost responses, leases, resume =====
{
 // A lost response AFTER the commit: the receipt decides (present = done); a lost response BEFORE the commit: absent, so the same chunk is sent again. No duplicate rows either way.
 for(const mode of ['after','before']){
  const file=copy(template);seedAll(file,120);
  const {manifest,digest}=await plan(records(120));
  let lost=false,calls=0;
  const db=flaky(file,{
   before:async texts=>{if(mode==='before'&&isReceipt(texts)&&++calls===2&&!lost){lost=true;throw new Error('network lost before commit');}},
   after:async texts=>{if(mode==='after'&&isReceipt(texts)&&++calls===2&&!lost){lost=true;throw new Error('network lost after commit');}},
  });
  const env={DB:db};
  await loadAndSealManifest(env,{manifest,approvedDigest:digest,now:at(10)});
  const result=await run(env,digest);
  assert.ok(lost,mode+': the loss happened');
  assert.equal(result.state,'complete');
  assert.equal(result.totals.inserted,120,mode);
  assert.equal(ledger(file).length,120,mode+': no duplicate rows');
  assert.deepEqual(rows(file,'SELECT chunk_no FROM identity_evidence_import_receipt ORDER BY chunk_no').map(row=>row.chunk_no),[1,2,3],mode);
 }
 // A loss that never recovers does not loop: it is thrown after the bounded retries, nothing landed, and the run stays resumable.
 const file=copy(template);seedAll(file,3);
 const {manifest,digest}=await plan(records(3));
 let attempts=0;
 const env={DB:flaky(file,{before:async texts=>{if(isReceipt(texts)){attempts++;throw new Error('network down');}}})};
 await loadAndSealManifest(env,{manifest,approvedDigest:digest,now:at(10)});
 await assert.rejects(()=>run(env,digest,{retries:1}),/network down/);
 assert.equal(attempts,2,'one send and one retry');
 assert.equal(ledger(file).length,0);
 assert.equal((await readImportRun(env,'run-1')).state,'running');
}
{
 // Stale lease on the DATABASE clock: owner A sends one chunk and disappears; a live lease of another owner is refused; after the expiry owner B takes over with a NEW attempt and
 // finishes; a chunk that A sends under its stale attempt fails the run assertion and the receipt's fence and writes nothing.
 const file=copy(template);seedAll(file,130);
 const {env,digest}=await staged(file,records(130));
 const partial=await run(env,digest,{owner:'operator-a',maxChunks:1,leaseMs:1000});
 assert.equal(partial.done,false);assert.equal(partial.chunks.length,1);
 assert.equal(ledger(file).length,50);
 await assert.rejects(()=>run(env,digest,{owner:'operator-b'}),code('identity_evidence_import_lease_held'));
 await sleep(1150);
 const claimed=await run(env,digest,{owner:'operator-b',maxChunks:1,leaseMs:60000});
 assert.equal(claimed.chunks.length,2);
 assert.equal((await readImportRun(env,'run-1')).attempt,2,'a resumed attempt takes a new lease');
 const staleChunk=(await readStagedManifest(env,'run-1')).chunks[2];
 const stale=chunkStatements({run:{runId:'run-1',manifestSha256:digest},chunk:staleChunk,attempt:1,at:at(20500)});
 await assert.rejects(()=>env.DB.batch(stale.map(([sql,params])=>env.DB.prepare(sql).bind(...params))),/CHECK constraint failed/);
 assert.equal(ledger(file).length,100,'the stale batch wrote nothing');
 // Even without the run assertion, the receipt's own trigger refuses an attempt that is not the live one.
 refused(file,"INSERT INTO identity_evidence_import_receipt (run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at) VALUES ('run-1',3,1,30,30,0,0,0,"+lit(at(20500))+")",/identity_evidence_import_receipt_fence/);
 // A chunk number that is not the next one, and a staged count that is not the chunk's.
 refused(file,"INSERT INTO identity_evidence_import_receipt (run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at) VALUES ('run-1',1,2,50,50,0,0,0,"+lit(at(20500))+")",/identity_evidence_import_receipt_(taken|fence)/);
 refused(file,"INSERT INTO identity_evidence_import_receipt (run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at) VALUES ('run-1',3,2,29,29,0,0,0,"+lit(at(20500))+")",/identity_evidence_import_receipt_fence/);
 refused(file,"INSERT INTO identity_evidence_import_receipt (run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at) VALUES ('run-1',3,2,30,10,0,0,0,"+lit(at(20500))+")",/CHECK constraint failed/);
 const finished=await run(env,digest,{owner:'operator-b'});
 assert.equal(finished.state,'complete');
 assert.equal(ledger(file).length,130);
 assert.deepEqual(finished.totals,{stagedKeys:130,inserted:130,alreadyImported:0,liveCovered:0,reconstructedEquivalent:0},'resume writes the exact manifest once');
}
{
 // A batch PREPARED while the lease was live and DELIVERED after it expired, with no takeover yet, must not commit: the lease is checked on the database's clock at commit, not on
 // the caller's timestamp. The run assertion and the receipt trigger both refuse; nothing lands and the run is untouched.
 const file=copy(template);seedAll(file,60);
 const {env,digest}=await staged(file,records(60));
 await run(env,digest,{maxChunks:1,leaseMs:1000});
 const second=(await readStagedManifest(env,'run-1')).chunks[1];
 const prepared=chunkStatements({run:{runId:'run-1',manifestSha256:digest},chunk:second,attempt:1,at:at(5)});
 await sleep(1150);
 await assert.rejects(()=>env.DB.batch(prepared.map(([sql,params])=>env.DB.prepare(sql).bind(...params))),/CHECK constraint failed/);
 assert.equal(ledger(file).length,50,'the delayed batch wrote nothing');
 const unchanged=await readImportRun(env,'run-1');
 assert.deepEqual([unchanged.state,unchanged.attempt],['running',1],'no takeover, no stop');
 // The receipt trigger alone is also on the database clock (a caller-supplied `recorded_at` in the past does not help).
 refused(file,"INSERT INTO identity_evidence_import_receipt (run_id,chunk_no,attempt,staged_keys,inserted,already_imported,live_covered,reconstructed_equivalent,recorded_at) VALUES ('run-1',2,1,10,10,0,0,0,"+lit(at(5))+")",/identity_evidence_import_receipt_fence/);
 refused(file,"UPDATE identity_evidence_import_run SET state='complete',updated_at='"+at(5)+"' WHERE run_id='run-1'",/identity_evidence_import_run_transition/);
 // The expired lease is taken over (a new attempt) and the run finishes; the same owner can also renew a live lease.
 assert.equal((await run(env,digest,{owner:'operator-b'})).state,'complete');
 assert.equal(ledger(file).length,60);
}
{
 // Two concurrent claimers: exactly one holds the lease and finishes; the other is refused. Two concurrent runs of overlapping keys write each key once.
 const file=copy(template);seedAll(file,6);
 const {env,digest}=await staged(file,records(6));
 const racers=await Promise.allSettled([run(env,digest,{owner:'operator-a'}),run(env,digest,{owner:'operator-b'})]);
 assert.ok(racers.some(item=>item.status==='fulfilled'),'one claimer finishes the run');
 for(const item of racers)if(item.status==='rejected')assert.equal(item.reason.code,'identity_evidence_import_lease_held',String(item.reason?.stack));
 assert.equal(ledger(file).length,6,'each key is written once');
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),1);
}
{
 // Two runs importing the same keys at the same time: every key is written once, the other run counts it as equivalent or replayed.
 const file=copy(template);seedAll(file,4);seed(file,1,2);seed(file,2,2);
 const one_=await staged(file,[record(1),record(2),record(3)],{runId:'run-1'});
 const two_=await staged(file,[record(1,{revision:2}),record(2,{revision:2}),record(4)],{runId:'run-2'});
 const results=await Promise.all([run(one_.env,one_.digest,{runId:'run-1'}),run(two_.env,two_.digest,{runId:'run-2'})]);
 assert.equal(ledger(file).length,4,'each of the four keys exists once');
 assert.equal(results[0].totals.inserted+results[1].totals.inserted,4);
 assert.equal(results[0].totals.reconstructedEquivalent+results[1].totals.reconstructedEquivalent,2);
}

// ===== 7. a pending writer =====
{
 const file=copy(template);seedAll(file,60);
 const {env,digest}=await staged(file,records(60));
 // The writer a run names is `pending`: the start is refused and the run stays sealed.
 await changeWriter(env,{writer:'discovery_decision',kind:'activate',expectedGeneration:0,reason:'test activation',deployedVersion:'abc123',evidenceLink:'https://example.test/evidence',now:at(100)});
 await assert.rejects(()=>run(env,digest),code('identity_evidence_import_blocked'));
 assert.equal((await readImportRun(env,'run-1')).state,'sealed');
 assert.equal(ledger(file).length,0);
 // `on` is fine; a writer the run does not name is irrelevant.
 await changeWriter(env,{writer:'discovery_decision',kind:'drain_complete',expectedGeneration:1,reason:'drained',deployedVersion:'abc123',evidenceLink:'https://example.test/evidence',drainEvidence:'one deployment at 100%',now:at(200)});
 await changeWriter(env,{writer:'claim_alias_bridge',kind:'activate',expectedGeneration:0,reason:'not named by the run',deployedVersion:'abc123',evidenceLink:'https://example.test/evidence',now:at(300)});
 const partial=await run(env,digest,{maxChunks:1,now:at(2000)});
 assert.equal(partial.chunks.length,1);
 // A writer that goes `pending` while the run is under way stops the next chunk: nothing of it lands and no receipt is written.
 await changeWriter(env,{writer:'discovery_decision',kind:'deactivate',expectedGeneration:2,reason:'again',deployedVersion:'abc123',evidenceLink:'https://example.test/evidence',now:at(2100)});
 await changeWriter(env,{writer:'discovery_decision',kind:'activate',expectedGeneration:3,reason:'again',deployedVersion:'abc123',evidenceLink:'https://example.test/evidence',now:at(2200)});
 await assert.rejects(()=>run(env,digest,{now:at(2500)}),code('identity_evidence_import_blocked'));
 assert.equal(ledger(file).length,50);
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),1);
 await changeWriter(env,{writer:'discovery_decision',kind:'deactivate',expectedGeneration:4,reason:'done',deployedVersion:'abc123',evidenceLink:'https://example.test/evidence',now:at(2600)});
 assert.equal((await run(env,digest,{now:at(2700)})).state,'complete');
}

// ===== 8. R2 sources: a LOGICAL record inside a PHYSICAL object; the pinned ETag is re-read before EVERY submission =====
const OBJECT='admin/actions/discovery_identity_correct/v1/a.json';
const r2Record=(i,record,over={})=>({source:{kind:'r2_object',key:OBJECT,record:record||('rec-'+i),etag:'etag-1',r2:'admin_action_applied',residualAccepted:true,...over},rows:[{evidence:evidence(i)}]});
{
 const list=()=>[r2Record(1),record(2)];
 const file=copy(template);seedAll(file,2);
 const {env,digest,report}=await staged(file,list());
 assert.equal(report.r2Residual.length,1);
 // No reader for R2: refused, nothing is written.
 await assert.rejects(()=>run(env,digest),code('identity_evidence_import_r2_unavailable'));
 assert.equal(ledger(file).length,0);
 // The ETag changed: the run stops and the chunk is not imported.
 await assert.rejects(()=>run(env,digest,{readEtag:async()=>'etag-2'}),code('identity_evidence_import_r2_moved'));
 assert.equal(ledger(file).length,0);
 assert.equal((await readImportRun(env,'run-1')).stopReason,'r2_moved');
 // The same ETag: imported, and each object is read once per submission of a chunk that uses it.
 const fine=copy(template);seedAll(fine,2);
 const staged2=await staged(fine,list());
 const reads=[];
 const result=await run(staged2.env,staged2.digest,{readEtag:async key=>{reads.push(key);return 'etag-1';}});
 assert.equal(result.state,'complete');assert.deepEqual(reads,[OBJECT]);
 assert.equal(ledger(fine).length,2);
 // The post-import readback states the pinned ETag, the chunks and the residual window of the object (ADR 0215 decision 7, step 6).
 const readback=await readImportReport(staged2.env,'run-1');
 assert.deepEqual(readback.r2Objects.map(item=>({key:item.key,etag:item.etag,chunks:item.chunks,records:item.records,receiptedChunks:item.receiptedChunks})),[{key:OBJECT,etag:'etag-1',chunks:[1],records:1,receiptedChunks:[1]}]);
 assert.match(readback.r2Objects[0].window,/ETag re-read before each submission/);
}
{
 // Family (a) shape: MANY distinct logical records from ONE frozen object, staged across bounded chunks (714 records: 703 inferred pairs and 11 records whose root is unknown).
 const total=714;
 const file=copy(template);
 const list=Array.from({length:total},(_,index)=>{const i=index+1;return {source:{kind:'r2_object',key:'verified-films.json',record:'admission-'+i,etag:'etag-v1',r2:'verified_films_after_a2',residualAccepted:true},
  rows:[{evidence:evidence(i,i>703?{sourceRoot:null}:{})}]};});
 const {env,digest,manifest,report}=await staged(file,list);
 assert.deepEqual(report.counts,{chunks:15,sources:total,rows:total},'every record is a source of its own, none dropped for sharing the object');
 assert.equal(new Set(manifest.chunks.flatMap(chunk=>chunk.sources.map(source=>source.token))).size,total,'distinct logical records, distinct tokens');
 assert.ok(manifest.chunks.every(chunk=>chunk.sources.every(source=>source.etag==='etag-v1'&&source.key==='verified-films.json')),'the physical object and its ETag are on every source');
 assert.deepEqual(report.r2Residual.map(item=>({key:item.key,chunks:item.chunks.length})),[{key:'verified-films.json',chunks:15}]);
 const reads=[];
 const result=await run(env,digest,{readEtag:async key=>{reads.push(key);return 'etag-v1';}});
 assert.equal(result.state,'complete');assert.equal(result.totals.inserted,total);
 assert.equal(reads.length,15,'the object is re-read for every chunk that uses it');
 assert.equal(ledger(file).length,total);
 const rootless=ledger(file).filter(row=>row.reconstructed_from!==null&&/^r2:/.test(row.reconstructed_from));
 assert.equal(rootless.length,total,'each row names its own logical record');
 assert.equal(new Set(rootless.map(row=>row.reconstructed_from)).size,total);
 // Replay by a later run (a new cohort, the object rewritten with another ETag): the same records are the same keys, and the rootless ones stay distinct per record.
 const again=await staged(file,list.map(item=>({...item,source:{...item.source,etag:'etag-v2'}})),{runId:'run-2'});
 const replayed=await run(again.env,again.digest,{runId:'run-2',readEtag:async()=>'etag-v2'});
 assert.deepEqual(replayed.totals,{stagedKeys:total,inserted:0,alreadyImported:total,liveCovered:0,reconstructedEquivalent:0},'an exact-record replay is idempotent across ETags');
 const back=await readImportReport(env,'run-1');
 assert.deepEqual(back.r2Objects.map(item=>[item.key,item.records,item.chunks.length,item.receiptedChunks.length]),[['verified-films.json',total,15,15]]);
 assert.equal((await readStagedManifest(env,'run-1')&&await manifestDigest(await readStagedManifest(env,'run-1'))),digest,'readback of the staged object records');
 // The same logical record with a contradicting ETag or descriptor is a source conflict: all of it is left out.
 const conflict=await plan([r2Record(1,'x'),r2Record(2,'x',{etag:'other'})]);
 assert.equal(conflict.report.counts.rows,0);assert.equal(conflict.manifest,null);assert.deepEqual(conflict.report.excluded.map(item=>item.reason),['source_conflict']);
}
{
 // The ETag is re-read before EVERY submission, not once per chunk: a transport failure before the commit, then the object changes, and the retry must stop with nothing written.
 const file=copy(template);seedAll(file,3);
 const {manifest,digest}=await plan([r2Record(1),r2Record(2),r2Record(3)]);
 let etag='etag-1',failed=0;
 const env={DB:flaky(file,{before:async texts=>{if(isReceipt(texts)&&failed++===0){etag='etag-2';throw new Error('network lost before commit');}}})};
 await loadAndSealManifest(env,{manifest,approvedDigest:digest,now:at(10)});
 await assert.rejects(()=>run(env,digest,{readEtag:async()=>etag}),code('identity_evidence_import_r2_moved'));
 assert.equal(ledger(file).length,0,'zero new ledger rows');
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),0,'no receipt');
 assert.equal((await readImportRun(env,'run-1')).stopReason,'r2_moved');
 // A lost RESPONSE after a committed receipt is settled by the receipt and never undone by a later ETag change; the next chunk is the one that stops.
 const second=copy(template);seedAll(second,60);
 const list=Array.from({length:60},(_,index)=>r2Record(index+1));
 const planned=await plan(list);
 let moved='etag-1',lost=false;
 const env2={DB:flaky(second,{after:async texts=>{if(isReceipt(texts)&&!lost){lost=true;moved='etag-2';throw new Error('network lost after commit');}}})};
 await loadAndSealManifest(env2,{manifest:planned.manifest,approvedDigest:planned.digest,now:at(10)});
 await assert.rejects(()=>run(env2,planned.digest,{readEtag:async()=>moved}),code('identity_evidence_import_r2_moved'));
 assert.equal(ledger(second).length,50,'chunk 1 committed and stays');
 assert.equal(one(second,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),1,'its receipt stays');
}

{
 // ONE pinned ETag per physical object across the whole manifest: different records of one object with different ETags exclude the WHOLE object (in one chunk and across chunks); the
 // other objects and D1 sources stay; an externally built manifest is refused by validation and the load; the seal trigger refuses it in the database too.
 const mixed=(i,etag)=>r2Record(i,undefined,{etag});
 const sameChunk=await plan([mixed(1,'v1'),mixed(2,'v2'),record(3)]);
 assert.deepEqual(sameChunk.report.counts,{chunks:1,sources:1,rows:1},'the conflicting object is left out whole; the D1 source stays');
 assert.deepEqual(sameChunk.report.conflicts,[{object:OBJECT,etags:['v1','v2'],reason:'r2_object_etag'}]);
 assert.deepEqual(sameChunk.report.excluded.map(item=>item.reason),['r2_object_conflict','r2_object_conflict']);
 assert.deepEqual(sameChunk.report.r2Residual,[],'no residual window is reported for an object that is not imported');
 // Across chunks (more than 50 records between the two ETags).
 const across=await plan([mixed(1,'v1'),...records(60,10),mixed(2,'v2')]);
 assert.deepEqual(across.report.counts,{chunks:2,sources:60,rows:60});
 assert.equal(across.report.conflicts.length,1);
 // A single-ETag object is untouched, and the same-ETag many-records case keeps one report entry.
 const fine=await plan([mixed(1,'v1'),mixed(2,'v1')]);
 assert.deepEqual(fine.report.r2Residual.map(item=>[item.key,item.etag,item.chunks]),[[OBJECT,'v1',[1]]]);
 assert.deepEqual(fine.report.conflicts,[]);
 // Only the conflicting object is excluded: another object with its own ETag stays.
 const other=await plan([mixed(1,'v1'),mixed(2,'v2'),{source:{kind:'r2_object',key:'verified-films.json',record:'x',etag:'e9',r2:'verified_films_after_a2',residualAccepted:true},rows:[{evidence:evidence(5)}]}]);
 assert.deepEqual(other.report.r2Residual.map(item=>item.key),['verified-films.json']);
 // An externally constructed manifest with mixed ETags (same chunk, and across chunks) is refused before anything is staged.
 const good=await plan([mixed(1,'v1'),mixed(2,'v1')]);
 const goodDigest=good.digest;
 for(const [name,edit] of [['same chunk',manifest=>{manifest.chunks[0].sources[1].etag='v2';}],
  ['across chunks',manifest=>{const copyOf=JSON.parse(JSON.stringify(manifest.chunks[0]));copyOf.chunkNo=2;copyOf.sources.forEach(source=>{source.etag='v2';source.token='r2:'+'0'.repeat(63)+source.ordinal;});copyOf.rows.forEach((row,index)=>{row.reconstructedFrom='r2:'+'0'.repeat(63)+row.sourceOrdinal;row.key=(index+9).toString(16).padStart(64,'0');});manifest.chunks.push(copyOf);}]]){
  const external=JSON.parse(JSON.stringify(good.manifest));edit(external);
  assert.throws(()=>validateManifest(external),error=>{assert.equal(error.code,'identity_evidence_import_invalid');assert.equal(error.reason,'r2_etag_conflict',name);return true;});
  const file=copy(template);
  await assert.rejects(()=>loadManifest(envOf(file),{manifest:external,approvedDigest:goodDigest}),code('identity_evidence_import_invalid'),name);
  assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_run'),0,name+': nothing is staged');
 }
 // The database refuses to seal a staging that holds one object under two ETags, whatever the code says.
 const file=copy(template);
 const run_=envOf(file);
 await run_.DB.batch([run_.DB.prepare('INSERT INTO identity_evidence_import_run (run_id,family,manifest_sha256,cohort_at,chunk_count,source_count,row_count,writers_json,state,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind('run-m','a',goodDigest,COHORT,1,2,2,'[]','staging',0,COHORT,COHORT)]);
 const row_=(ordinal,tok)=>"INSERT INTO identity_evidence_import_row (run_id,chunk_no,ordinal,source_ordinal,evidence_key,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,reconstructed_from) VALUES ('run-m',1,"+ordinal+","+ordinal+",'"+String(ordinal).repeat(64)+"','discovery_observation','x|"+ordinal+"','candidate_for','tmdb_movie','1','asserts','discovery_scan','tmdb_detail_check','x|"+ordinal+"',"+lit(SEEN)+",'"+tok+"')";
 ok(file,"INSERT INTO identity_evidence_import_chunk (run_id,chunk_no,source_count,row_count) VALUES ('run-m',1,2,2);"
  +"INSERT INTO identity_evidence_import_source (run_id,chunk_no,ordinal,kind,source_key,record_ref,etag,source_token) VALUES ('run-m',1,1,'r2_object','obj.json','a','v1','t1');"
  +"INSERT INTO identity_evidence_import_source (run_id,chunk_no,ordinal,kind,source_key,record_ref,etag,source_token) VALUES ('run-m',1,2,'r2_object','obj.json','b','v2','t2');"+row_(1,'t1')+';'+row_(2,'t2'));
 refused(file,"INSERT INTO identity_evidence_import_seal (run_id,manifest_sha256,chunk_count,source_count,row_count,sealed_at) VALUES ('run-m','"+goodDigest+"',1,2,2,"+lit(at(1))+")",/identity_evidence_import_seal_mismatch/);
 assert.equal(one(file,"SELECT state FROM identity_evidence_import_run WHERE run_id='run-m'"),'staging');
}

// ===== 9. the review contract: same-source conflicts, mandatory writers, report-only dry run, truthful readback, stale stops, REPLACE-proof sources =====
{
 // Repeated inputs of ONE source compare their descriptors and ALL their mappings: contradictory data is never first-wins.
 const owner=(order,over={})=>({subject:{kind:'discovery_observation',value:OBS(9)},relation:'candidate_for',object:{kind:'tmdb_movie',value:'109'},polarity:'asserts',route:'owner_action',method:'owner_statement',sourceRoot:'intent-9',observedAt:SEEN,sourceOrder:order,...over});
 const sameSource=(...rows)=>rows.map(rowEvidence=>({source:source(9,1),rows:[{evidence:rowEvidence}]}));
 const conflict=await plan([...sameSource(owner(1),owner(2)),record(1)]);
 assert.equal(conflict.report.counts.rows,1,'the key whose source_order disagrees inside one source is left out');
 assert.equal(conflict.report.conflicts.length,1);
 const agree=await plan(sameSource(owner(2),owner(2)));
 assert.equal(agree.report.conflicts.length,0);assert.equal(agree.report.duplicates.length,1);assert.deepEqual(agree.report.counts,{chunks:1,sources:1,rows:1});
 // Disjoint keys of one repeated source are all kept (merged), not silently lost.
 const merged=await plan([{source:source(9,1),rows:[{evidence:owner(2)}]},{source:source(9,1),rows:[{evidence:owner(2,{object:{kind:'tmdb_movie',value:'110'}})}]}]);
 assert.deepEqual(merged.report.counts,{chunks:1,sources:1,rows:2});
 // Changed guard fields or ETag between two inputs of one source: a reported source conflict, all its rows are left out.
 const guardClash=await plan([record(1),{source:{...source(1),guard:{written_at:'2026-11-09T00:00:00.000Z'}},rows:[{evidence:evidence(1,{object:{kind:'tmdb_movie',value:'999'}})}]},record(2)]);
 assert.deepEqual(guardClash.report.counts,{chunks:1,sources:1,rows:1});
 assert.deepEqual(guardClash.report.excluded.map(item=>item.reason),['source_conflict']);
 assert.equal(guardClash.report.conflicts[0].reason,'source_descriptor');
}
{
 // A report-only dry run: nothing eligible is a well-defined zero-row result, never a throw and never something an import GO can stage.
 for(const [name,records_] of [['an empty extraction',[]],['no rows',[{source:source(1),rows:[]}]],
  ['all excluded R2 objects',[r2Record(1,undefined,{residualAccepted:false}),r2Record(2,undefined,{r2:'admin_action_pending'})]],
  ['all conflicting',[{source:source(1),rows:[{evidence:evidence(1)}]},{source:{...source(1),guard:{written_at:'x'}},rows:[{evidence:evidence(1)}]}]]]){
  const result=await plan(records_);
  assert.equal(result.manifest,null,name);assert.equal(result.digest,null,name);
  assert.equal(result.report.disposition,'no_import',name);
  assert.deepEqual(result.report.counts,{chunks:0,sources:0,rows:0},name);
  assert.ok(result.report.excluded.length>0||records_.length===0,name+': reasons are reported');
 }
 const file=copy(template);
 await assert.rejects(()=>loadManifest(envOf(file),{manifest:null,approvedDigest:'0'.repeat(64)}),code('identity_evidence_import_invalid'));
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_run'),0,'no zero-chunk run is created');
 const eligible=await plan(records(2));
 assert.equal(eligible.report.disposition,'import_candidate');
}
{
 // The pending-writer guard is derived from the FAMILY, not from the extractor: a family `b` manifest cannot omit the Discovery writers, and the database requires both `on`.
 await assert.rejects(()=>plan(records(1),{family:'b',writers:[]}),code('identity_evidence_import_invalid'));
 await assert.rejects(()=>plan(records(1),{family:'b',writers:['discovery_decision']}),code('identity_evidence_import_invalid'));
 assert.deepEqual((await plan(records(1),{family:'b',writers:undefined})).manifest.writers,['discovery_decision','discovery_owner'],'the default is the required set');
 const omitted=await plan(records(1),{family:'b',writers:undefined});
 const stripped=JSON.parse(JSON.stringify(omitted.manifest));stripped.writers=[];
 const omittedDigest=await manifestDigest(omitted.manifest);
 await assert.rejects(()=>loadManifest(envOf(copy(template)),{manifest:stripped,approvedDigest:omittedDigest}),code('identity_evidence_import_invalid'));
 // Pure dry runs and staging work before any writer is active; the IMPORT needs both `on`.
 const file=copy(template);seedAll(file,60);
 const {env,digest}=await staged(file,records(60),{family:'b',writers:undefined});
 const setting=(writer,kind,generation,extra={})=>changeWriter(env,{writer,kind,expectedGeneration:generation,reason:'test',deployedVersion:'abc',evidenceLink:'https://example.test/e',...extra});
 await assert.rejects(()=>run(env,digest),code('identity_evidence_import_blocked'));
 await setting('discovery_decision','activate',0);await setting('discovery_decision','drain_complete',1,{drainEvidence:'drained'});
 await assert.rejects(()=>run(env,digest),code('identity_evidence_import_blocked'));
 assert.equal((await readImportRun(env,'run-1')).state,'sealed','one writer `on` and the other absent: refused');
 await setting('discovery_owner','activate',0);
 await assert.rejects(()=>run(env,digest),code('identity_evidence_import_blocked'));
 await setting('discovery_owner','drain_complete',1,{drainEvidence:'drained'});
 assert.equal((await run(env,digest,{maxChunks:1})).chunks.length,1);
 // A writer switched `off` mid-run stops the next chunk (nothing of it lands); switched back `on`, the run resumes.
 await setting('discovery_owner','deactivate',2);
 await assert.rejects(()=>run(env,digest),code('identity_evidence_import_blocked'));
 assert.equal(ledger(file).length,50);assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),1);
 await setting('discovery_owner','activate',3);await setting('discovery_owner','drain_complete',4,{drainEvidence:'drained again'});
 assert.equal((await run(env,digest)).state,'complete');
 // The run's own list cannot lower it: it is immutable, and an empty list in the run row changes nothing for family `b`.
 refused(file,"UPDATE identity_evidence_import_run SET writers_json='[]',updated_at='"+at(1)+"'",/identity_evidence_import_run_transition/);
}
{
 // The report is truthful: only RECEIPTED chunks and the exact identity predicate. Run 2 stops in chunk 2 on a collision while an earlier reconstruction of an unrelated row of that
 // chunk exists; that row is never reported as equivalent, and the reported pairs equal the receipts' total.
 const owner=(order)=>({subject:{kind:'discovery_observation',value:OBS(52)},relation:'candidate_for',object:{kind:'tmdb_movie',value:'152'},polarity:'asserts',route:'owner_action',method:'owner_statement',sourceRoot:'intent-52',observedAt:SEEN,sourceOrder:order});
 const file=copy(template);seedAll(file,55);seed(file,1,2);seed(file,51,2);
 const first=await staged(file,[record(1),record(51),{source:source(52),rows:[{evidence:owner(1)}]}]);
 await run(first.env,first.digest);
 const second=await staged(file,[record(1,{revision:2}),...records(49,2),record(51,{revision:2}),{source:source(52,1),rows:[{evidence:owner(7)}]}],{runId:'run-2'});
 await assert.rejects(()=>run(second.env,second.digest,{runId:'run-2'}),code('identity_evidence_import_collision'));
 const back=await readImportReport(second.env,'run-2');
 assert.equal(back.receipts.length,1,'only chunk 1 committed');
 assert.equal(back.totals.reconstructedEquivalent,1);
 assert.equal(back.equivalents.length,1,'the pair of the never-committed chunk 2 (record 51) is not reported');
 assert.equal(back.equivalentsMatchReceipts,true);
 assert.deepEqual(back.equivalents.map(item=>item.existingRun),['run-1']);
 // A completed run agrees with its receipts too, and a partial run (stopped by the owner) never reports an uncommitted pair.
 const third=await staged(file,[record(1,{revision:2}),record(51,{revision:2})],{runId:'run-3'});
 const finished=await run(third.env,third.digest,{runId:'run-3'});
 const done=await readImportReport(third.env,'run-3');
 assert.equal(done.equivalents.length,finished.totals.reconstructedEquivalent+0);assert.equal(done.equivalentsMatchReceipts,true);
}
{
 // A stale attempt cannot stop its successor. A is inside a slow R2 read (it holds attempt 1) when its lease expires and B takes over; A's late "moved" answer must not stop the run.
 const file=copy(template);seedAll(file,60);
 const list=Array.from({length:60},(_,index)=>r2Record(index+1));
 const {env,digest}=await staged(file,list);
 let release,inside;
 const gate=new Promise(resolve=>{release=resolve;});
 const entered=new Promise(resolve=>{inside=resolve;});
 const slow=run(env,digest,{owner:'operator-a',leaseMs:1000,readEtag:async()=>{inside();await gate;return 'changed-by-a-stale-view';}});
 const outcome=slow.then(()=>null,error=>error);
 await entered;
 await sleep(1150);
 const takeover=await run(env,digest,{owner:'operator-b',maxChunks:1,readEtag:async()=>'etag-1'});
 assert.equal(takeover.chunks.length,1);
 assert.equal((await readImportRun(env,'run-1')).attempt,2);
 release();
 const error=await outcome;
 assert.equal(error?.code,'identity_evidence_import_lease_lost',String(error?.stack));
 const after=await readImportRun(env,'run-1');
 assert.deepEqual([after.state,after.attempt,after.leaseOwner,after.stopReason],['running',2,'operator-b',null],'the successor is untouched');
 assert.equal((await run(env,digest,{owner:'operator-b',readEtag:async()=>'etag-1'})).state,'complete');
 // The separately authorized operator stop IS unconditional, and the lease holder then fails its fence.
 const other=copy(template);seedAll(other,60);
 const staged2=await staged(other,records(60));
 await run(staged2.env,staged2.digest,{owner:'operator-a',maxChunks:1,leaseMs:60000});
 const stopped=await stopImportRun(staged2.env,{runId:'run-1',now:at(50)});
 assert.deepEqual([stopped.state,stopped.stopReason],['stopped','owner']);
 await assert.rejects(()=>run(staged2.env,staged2.digest,{owner:'operator-a'}),code('identity_evidence_import_stopped'));
 assert.equal(ledger(other).length,50);
}
{
 // A source record is insert-only on BOTH of its unique keys: INSERT OR REPLACE or an upsert with the same token at a free ordinal (or the same ordinal with another token) deletes
 // nothing, with recursive triggers off and on, before the seal.
 for(const recursive of ['OFF','ON']){
  const file=copy(template);seedAll(file,2);
  const env=envOf(file);const {manifest,digest}=await plan(records(2));
  await loadManifest(env,{manifest,approvedDigest:digest,now:at(10)});
  const token=manifest.chunks[0].sources[0].token;
  const before=one(file,'SELECT COUNT(*) FROM identity_evidence_import_source');
  const insert=(verb,ordinal,tok)=>'PRAGMA recursive_triggers='+recursive+';'+verb+" INTO identity_evidence_import_source (run_id,chunk_no,ordinal,kind,source_table,source_key,guard_json,source_token) VALUES ('run-1',1,"+ordinal+",'d1_row','discovery_decision_history','{}','{}',"+lit(tok)+")";
  refused(file,insert('INSERT OR REPLACE',9,token),/identity_evidence_import_sealed/);
  refused(file,insert('REPLACE',9,token),/identity_evidence_import_sealed/);
  refused(file,insert('INSERT OR REPLACE',1,'another-token'),/identity_evidence_import_sealed/);
  refused(file,insert('INSERT',9,token)+" ON CONFLICT(run_id,source_token) DO UPDATE SET ordinal=9",/identity_evidence_import_sealed/);
  assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_source'),before,'recursive_triggers='+recursive+': no source was replaced');
  assert.equal(await manifestDigest(await readStagedManifest(env,'run-1')),digest,'the staging is intact');
 }
}

// ===== 9. dormant: nothing in the Worker imports the import path, nothing reads the ledger or the staging =====
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const mentions=sources.filter(name=>/identity_evidence_import/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(mentions,['src/identity-evidence-import.js'],'no other module reads or writes the import tables');
 const importers=sources.filter(name=>/from\s+['"]\.{1,2}\/(?:[\w-]+\/)*identity-evidence-import\.js['"]/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(importers,[],'nothing imports the import path: no route, Workflow, cron or producer calls it');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('identity-evidence-import'),'the Worker bundle does not include the import path');
 for(const workflow of fs.readdirSync('.github/workflows')){
  assert.ok(!/migrations\s+apply|d1\s+execute|0044_identity/.test(fs.readFileSync('.github/workflows/'+workflow,'utf8')),workflow+' does not apply 0044');
 }
 const text=fs.readFileSync('src/identity-evidence-import.js','utf8');
 assert.ok(!/\bfetch\(|\bR2\b.*\.put\(|crypto\.randomUUID/.test(text),'no network, R2 write or random id');
}
console.log('identity evidence reconstruction import: ok');
