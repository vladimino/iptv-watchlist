// AIR-664 (ADR 0225): the one-off owner-only repair of the 16 stale Film localization rows (src/film-localization-repair.js, the body of the MCP tool `film_localization_repair`) on real SQLite
// (the sqlite3-CLI D1 stand-in) and an in-memory R2 bucket. SYNTHETIC Films and values only; no Worker, Cloudflare access or production invocation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const load=name=>import(pathToFileURL(path.resolve('src',name)).href);
// FILM_REPAIR_MODULE points the same scenarios at the BUILT bundle (a shim that re-exports the bundled scope), proving the scoped wiring and not only the source module.
const X=process.env.FILM_REPAIR_MODULE?await import(pathToFileURL(path.resolve(process.env.FILM_REPAIR_MODULE)).href):await load('film-localization-repair.js');
const {REPAIR_COHORT:COHORT,REPAIR_PREFIX:PREFIX}=X;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-repair-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const exec=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
exec(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database(){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 exec(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE);
 exec(file,"UPDATE owner_review_authority SET mode='d1',generation=1 WHERE id=1");
 return file;
}
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const T='2026-11-25T10:00:00.000Z',T1='2026-11-25T11:00:00.000Z',T3='2026-11-25T13:00:00.000Z';
const clock=()=>T3;
const tmdbOf=id=>String(100000+COHORT.indexOf(id));
const seedFilm=(file,id,tmdb)=>exec(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(id)+",1,"+q('tmdb:'+tmdb)+",NULL,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(id)+",'tmdb',"+q(tmdb)+",1,0,NULL);");
const sourceRow=(file,id,source,value,observedAt)=>exec(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ("+q(id)+","+q(source)+","+q(value)+",'v1','null','hist-1',"+q(observedAt)+","+q(observedAt)+")");
// A Film with a source row and NO effective row: the stale shape the census found.
const staleFilm=(file,id)=>{seedFilm(file,id,tmdbOf(id));sourceRow(file,id,'tmdb','Значение '+id,T1);};
const seedCohort=(file,{except=[]}={})=>{for(const id of COHORT)if(!except.includes(id))staleFilm(file,id);};
const revision=(file,id)=>Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id="+q(id)+"),0)")??0);
const revisionAt=(file,id)=>one(file,"SELECT updated_at FROM canonical_revision WHERE kind='film' AND id="+q(id));
const locRow=(file,id)=>rows(file,"SELECT status,source,value,authority FROM film_dimension WHERE dimension='localization' AND film_id="+q(id))[0]||null;
const receipts=file=>rows(file,"SELECT request_id,operation,origin,target_id,state,applied_revision FROM canonical_write_receipt ORDER BY request_id");
const reconcileReceipts=file=>receipts(file).filter(row=>row.operation==='film_localization_reconcile');
// Data only: the rows the operation may change, without receipts (a refused attempt may leave a non-applied receipt of the attempt itself).
const dataWorld=file=>JSON.stringify([rows(file,"SELECT film_id,dimension,status,source,value,authority,updated_at FROM film_dimension ORDER BY film_id,dimension"),rows(file,"SELECT film_id,source,value FROM film_localization_source ORDER BY film_id,source"),rows(file,"SELECT kind,id,revision,updated_at FROM canonical_revision ORDER BY kind,id"),rows(file,"SELECT kind,source_key,payload_json,generation FROM owner_review_entry ORDER BY source_key")]);
const world=file=>dataWorld(file)+JSON.stringify(receipts(file));
const appliedReceipts=file=>receipts(file).filter(row=>row.state==='applied').length;
const snapBucket=bucket=>JSON.stringify([...bucket.objects.entries()].sort(([a],[b])=>a<b?-1:1).map(([key,item])=>[key,item.text]));
const keys=bucket=>[...bucket.objects.keys()].sort();
const isIntent=key=>key.includes('/intents/'),isEvent=key=>key.includes('/events/');
const tool=(env,args)=>X.handleFilmLocalizationRepairTool(env,args,{now:clock});
const envOf=(file,bucket=new MemoryBucket())=>({DB:d1Standin(file),BUCKET:bucket});
const fresh=(options={})=>{const file=database();seedCohort(file,options);const bucket=new MemoryBucket();return {file,bucket,env:envOf(file,bucket)};};
const applyArgs=pre=>({mode:'apply',confirmGo:true,expectedFilmPersonGeneration:pre.expect.filmPersonGeneration,expectedSchemaVersion:pre.expect.schemaVersion,expectedOwnerReviewGeneration:pre.expect.ownerReviewGeneration,expectedOwnerReviewWrites:pre.expect.ownerReviewWrites,expectedPlanAt:pre.expect.planAt,expectedCount:pre.expect.count,expectedDigest:pre.expect.digest});
const restoreArgs=(recover,id)=>{const item=recover.items.find(entry=>entry.id===id&&entry.restore&&(entry.recordedState==='applied'||entry.recordedState==='restored'));return {mode:'restore',confirmGo:true,filmId:id,expectedFilmPersonGeneration:recover.pins.filmPersonGeneration,expectedSchemaVersion:recover.pins.schemaVersion,expectedOwnerReviewGeneration:recover.pins.ownerReviewGeneration,expectedOwnerReviewWrites:recover.pins.ownerReviewWrites,expectedRestoreDigest:item.restore.digest};};
const preflight=async env=>(await tool(env,{})).body;
const recoverOf=async env=>(await tool(env,{mode:'recover'})).body;
const applyAll=async(env,pre)=>(await tool(env,applyArgs(pre??await preflight(env)))).body;
const stateCount=(body,state)=>body.items.filter(item=>item.state===state).length;
const isWrite=item=>/INSERT INTO film_dimension|DELETE FROM film_dimension|UPDATE film_dimension/.test(item.text);
const isReservation=item=>/INSERT INTO canonical_write_receipt/.test(item.text);
// A D1 binding whose batch runs `hook(statements)` BEFORE the batch (to move a pin or a Film at exactly that boundary).
const before=(file,bucket,hook)=>{const db=d1Standin(file),real=db.batch.bind(db);db.batch=async statements=>{await hook(statements);return real(statements);};return {DB:db,BUCKET:bucket};};
// A D1 binding that COMMITS the first batch matching `match` and then loses the reply.
const lossy=(file,bucket,match)=>{const db=d1Standin(file),real=db.batch.bind(db);let armed=true;db.batch=async statements=>{const result=await real(statements);if(armed&&statements.some(item=>match.test(item.text))){armed=false;throw new Error('D1_ERROR: network connection lost');}return result;};return {DB:db,BUCKET:bucket};};
// An R2 bucket whose conditional put can be made to fail for outcome events or to run a hook after an intent object was created, and whose listing can be made to fail.
const flaky=inner=>{const flags={failEvents:false,failList:false,afterIntent:null,beforeIntent:null};return {flags,put:async(key,body,options)=>{if(flags.failEvents&&isEvent(key))throw new Error('R2 down');if(isIntent(key)&&flags.beforeIntent){const hook=flags.beforeIntent;flags.beforeIntent=null;await hook();}const saved=await inner.put(key,body,options);if(saved&&isIntent(key)&&flags.afterIntent){const hook=flags.afterIntent;flags.afterIntent=null;hook();}return saved;},get:key=>inner.get(key),list:async options=>{if(flags.failList)throw new Error('R2 list down');return inner.list(options);},objects:inner.objects};};
const forged=(intent,seq,state)=>({version:1,requestId:intent.requestId,digest:intent.digest,state,errorClass:null,receiptState:null,revision:state==='applied'?intent.postRevision:null,via:'apply',seq});

// ---- 0. The cohort is the AIR-683 evidence list, fixed, sorted and unique ----
{
 const evidence=fs.readFileSync('docs/evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md','utf8');
 const listed=[...evidence.match(/\*\*Observed stale Film ids[^\n]*\n\n([^\n]*)/)[1].matchAll(/`(film:[^`]+)`/g)].map(match=>match[1]);
 assert.equal(COHORT.length,16);
 assert.deepEqual([...COHORT],listed,'the code constant equals the ids recorded in the AIR-683 evidence');
 assert.deepEqual([...COHORT],[...COHORT].sort(),'code-unit order');
 assert.equal(new Set(COHORT).size,16);
 assert.throws(()=>{COHORT.push('film:x');},TypeError,'frozen');
 // The approved pins the fenced path accepts are validated values, never SQL.
 const {fenced}=await load('canonical-mutations.js');
 for(const bad of [null,[],{},{filmPersonGeneration:-1,schemaVersion:1,ownerReviewGeneration:0,ownerReviewWrites:'open'},{filmPersonGeneration:2,schemaVersion:0,ownerReviewGeneration:0,ownerReviewWrites:'open'},{filmPersonGeneration:2,schemaVersion:1,ownerReviewGeneration:0,ownerReviewWrites:'closed'},{filmPersonGeneration:'2',schemaVersion:1,ownerReviewGeneration:0,ownerReviewWrites:'open'}])assert.throws(()=>fenced.approvedPinsOf(bad),error=>error.code==='film_person_invalid');
 assert.deepEqual({...fenced.approvedPinsOf({filmPersonGeneration:2,schemaVersion:54,ownerReviewGeneration:1,ownerReviewWrites:'held',sql:'DROP TABLE film'})},{filmPersonGeneration:2,schemaVersion:54,ownerReviewGeneration:1,ownerReviewWrites:'held'},'only the four values are kept');
}

// ---- 1. Argument gates: nothing is derived or written without the exact write arguments ----
{
 const {file,bucket,env}=fresh();const snap=world(file);
 const pins={expectedFilmPersonGeneration:2,expectedSchemaVersion:54,expectedOwnerReviewGeneration:1,expectedOwnerReviewWrites:'open'};
 const hex='a'.repeat(64),at='2026-11-25T13:00:00.000Z';
 const full={mode:'apply',confirmGo:true,...pins,expectedPlanAt:at,expectedCount:3,expectedDigest:hex};
 for(const [args,reason] of [
  [null,'invalid'],[[],'invalid'],[{mode:'wave'},'invalid_mode'],[{mode:'apply'},'confirm_required'],[{mode:'apply',confirmGo:'yes'},'invalid_confirm'],
  [{mode:'apply',confirmGo:true},'invalid_expected_film_person_generation'],
  [{...full,expectedSchemaVersion:undefined},'invalid_expected_schema_version'],[{...full,expectedSchemaVersion:0},'invalid_expected_schema_version'],
  [{...full,expectedOwnerReviewGeneration:undefined},'invalid_expected_owner_review_generation'],
  [{...full,expectedOwnerReviewWrites:'closed'},'invalid_expected_owner_review_writes'],[{...full,expectedOwnerReviewWrites:undefined},'invalid_expected_owner_review_writes'],
  [{...full,expectedPlanAt:undefined},'invalid_expected_plan_at'],[{...full,expectedPlanAt:'2026-11-25'},'invalid_expected_plan_at'],[{...full,expectedPlanAt:'2027-01-01T00:00:00.000Z'},'invalid_expected_plan_at'],
  [{...full,expectedCount:17},'invalid_expected_count'],[{...full,expectedDigest:'xyz'},'invalid_expected_digest'],
  [{...full,filmId:COHORT[0]},'invalid_film_id_for_apply'],[{...full,expectedRestoreDigest:hex},'invalid_film_id_for_apply'],
  [{mode:'preflight',confirmGo:true},'invalid_arguments_for_read_only_mode'],[{mode:'recover',filmId:COHORT[0]},'invalid_arguments_for_read_only_mode'],[{mode:'preflight',expectedCount:1},'invalid_arguments_for_read_only_mode'],[{mode:'recover',expectedPlanAt:at},'invalid_arguments_for_read_only_mode'],
  [{mode:'restore'},'confirm_required'],[{mode:'restore',confirmGo:true},'invalid_film_id'],[{mode:'restore',confirmGo:true,filmId:'film:tmdb:9999'},'invalid_film_id'],
  [{mode:'restore',confirmGo:true,filmId:COHORT[0]},'invalid_expected_film_person_generation'],
  [{mode:'restore',confirmGo:true,filmId:COHORT[0],...pins},'invalid_expected_restore_digest'],
  [{mode:'restore',confirmGo:true,filmId:COHORT[0],...pins,expectedRestoreDigest:hex,expectedCount:1},'invalid_arguments_for_restore'],[{mode:'restore',confirmGo:true,filmId:COHORT[0],...pins,expectedRestoreDigest:hex,expectedPlanAt:at},'invalid_arguments_for_restore'],
 ]){
  const result=await tool(env,args);
  assert.deepEqual([result.status,result.body.reason],[400,reason],JSON.stringify(args));
 }
 assert.equal(world(file),snap);assert.equal(bucket.objects.size,0,'no argument error touches D1 or R2');
}

// ---- 2. Preflight: read only, per-Film CURRENT states, reproducible digest, plan time, no payload, no write ----
const main=fresh();
const {file,bucket,env}=main;
const OTHER='film:tmdb:9999';
seedFilm(file,OTHER,'9999');sourceRow(file,OTHER,'tmdb','Чужое',T1);
let pre;
{
 const snap=world(file);
 pre=(await tool(env,{})).body;
 const again=await preflight(env);
 assert.deepEqual([pre.ok,pre.mode,pre.sideEffects,pre.decision,pre.cohort,pre.failure],[true,'preflight','none','eligible',16,null]);
 assert.equal(pre.counts.eligible,16);assert.equal(pre.counts.cohort,16);
 for(const state of ['recorded','applied','applied_moved','applied_unproved','restored','restored_unproved','noop','held','absent','unavailable'])assert.equal(pre.counts[state],0,state);
 assert.deepEqual(pre.items.map(item=>item.id),[...COHORT]);
 assert.ok(pre.items.every(item=>item.state==='eligible'&&/^[0-9a-f]{64}$/.test(item.digest)&&item.plannedRevision===0&&/^localization_reconciler:film_localization_reconcile:[0-9a-f]{64}$/.test(item.requestId)));
 const version=Number(one(file,'SELECT version FROM schema_contract WHERE id=1'));
 assert.deepEqual(pre.expect,{filmPersonGeneration:2,schemaVersion:version,ownerReviewGeneration:1,ownerReviewWrites:pre.pins.ownerReviewWrites,planAt:T3,count:16,digest:pre.expect.digest},'every pin the approval depends on, the plan time, the count and the digest');
 assert.match(pre.expect.digest,/^[0-9a-f]{64}$/);
 assert.equal(again.expect.digest,pre.expect.digest,'the same state and plan time: the digest is reproducible');
 assert.deepEqual(pre.pins,{filmPersonState:'open',filmPersonGeneration:2,schemaVersion:version,ownerReviewMode:'d1',ownerReviewWrites:pre.pins.ownerReviewWrites,ownerReviewGeneration:1});
 const text=JSON.stringify(pre);
 assert.ok(!text.includes('Значение')&&!text.includes('preImage')&&!text.includes('postImage')&&!text.includes(PREFIX),'no localization value, intent body or R2 key in the answer');
 assert.equal(world(file),snap,'a preflight writes no D1 row and opens no receipt');assert.equal(bucket.objects.size,0,'a preflight writes no R2 object');
 const recover=await recoverOf(env);
 assert.deepEqual([recover.ok,recover.sideEffects,recover.items],[true,'none',[]]);
 assert.deepEqual(recover.pins,pre.pins);
}

// ---- 3. A mismatch of any pin, the count or the digest writes nothing; a schema or owner-state change between the calls is refused ----
{
 const snap=world(file);
 const patches=[[{expectedDigest:'0'.repeat(64)},['digest']],[{expectedCount:15},['count']],[{expectedFilmPersonGeneration:3},['filmPersonGeneration']],[{expectedOwnerReviewGeneration:2},['ownerReviewGeneration']],[{expectedSchemaVersion:pre.expect.schemaVersion+1},['schemaVersion']],[{expectedOwnerReviewWrites:pre.expect.ownerReviewWrites==='open'?'held':'open'},['ownerReviewWrites']],[{expectedPlanAt:'2026-11-25T12:00:00.000Z'},['digest']]];
 for(const [patch,mismatched] of patches){
  const result=await tool(env,{...applyArgs(pre),...patch});
  assert.equal(result.status,409,JSON.stringify(patch));
  assert.deepEqual([result.body.writes,result.body.mismatched],[0,mismatched],JSON.stringify(patch));
 }
 assert.equal(world(file),snap);assert.equal(bucket.objects.size,0,'a refused apply records nothing');
 // A schema apply between the approved preflight and the apply leaves both generations and every digest unchanged: the old approval is still refused.
 const s=fresh();const p=await preflight(s.env);
 exec(s.file,'UPDATE schema_contract SET version=version+1 WHERE id=1');
 const snapSchema=world(s.file);
 const moved=await tool(s.env,applyArgs(p));
 assert.deepEqual([moved.status,moved.body.reason,moved.body.writes,moved.body.mismatched],[409,'pins_mismatch',0,['schemaVersion']]);
 assert.equal(world(s.file),snapSchema);assert.equal(s.bucket.objects.size,0);
 // An owner-review state change (writes open to held) is refused the same way.
 const o=fresh();const po=await preflight(o.env);
 exec(o.file,"UPDATE owner_review_authority SET writes='"+(po.expect.ownerReviewWrites==='open'?'held':'open')+"' WHERE id=1");
 const ownerMoved=await tool(o.env,applyArgs(po));
 assert.deepEqual([ownerMoved.status,ownerMoved.body.reason,ownerMoved.body.writes,ownerMoved.body.mismatched],[409,'pins_mismatch',0,['ownerReviewWrites']]);
}

// ---- 4. A held Film blocks the whole apply: zero effects; so do a redirect, an authority that is not open and a missing checkpoint ----
{
 const f=fresh();
 exec(f.file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ('film:xG0M','localization','reviewed','owner','verified',NULL,'Чужое','owner',0,'keep_reviewed','"+T+"')");
 exec(f.file,"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','tmdb_xg0m',"+q(JSON.stringify({localization:{status:'reviewed',value:'Жара',provenance:{authority:'owner'},updatedAt:T}}))+",'film:xG0M','verified',1)");
 const snap=world(f.file);
 const held=await preflight(f.env);
 assert.deepEqual([held.decision,held.counts.held,held.counts.eligible,Object.keys(held.heldByReason).length],['blocked',1,15,1]);
 const refused=await tool(f.env,applyArgs({expect:{...held.expect,count:15}}));
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'not_eligible',0]);
 assert.equal(world(f.file),snap);assert.equal(f.bucket.objects.size,0);
 const g=fresh();exec(g.file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:merged',1,'tmdb:777',NULL,'"+T+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:xG0M','film:merged','"+T+"')");
 const abs=await preflight(g.env);
 assert.deepEqual([abs.decision,abs.counts.absent],['blocked',1]);
 const h=fresh();exec(h.file,"UPDATE owner_review_authority SET mode='r2' WHERE id=1");
 const unsafe=await preflight(h.env);
 assert.deepEqual([unsafe.decision,unsafe.failure,unsafe.expect],['unsafe','localization_owner_unavailable',null]);
 const missing=await tool({DB:d1Standin(database())},{});
 assert.deepEqual([missing.status,missing.body.decision,missing.body.failure,missing.body.expect],[200,'unknown','checkpoint_unavailable',null]);
}

// ---- 5. Apply: record BEFORE the write, one receipted atomic batch per Film under the approved pins, settle after, current scoped readback of all 16 ----
let applied;
{
 const otherBefore=JSON.stringify([locRow(file,OTHER),revision(file,OTHER)]);
 const callsBefore=env.DB.calls.queries+env.DB.calls.batches;
 const result=await tool(env,applyArgs(pre));
 applied=result.body;
 assert.equal(result.status,200);
 // The REAL budget: D1 allows 1,000 queries per Worker invocation (a batch counts once). The meter counts every execution, failed ones included, and agrees with the stand-in's own counters.
 assert.equal(applied.d1Queries,env.DB.calls.queries+env.DB.calls.batches-callsBefore,'the meter counts exactly what reached D1');
 assert.ok(applied.d1Queries<applied.d1QueryLimit&&applied.d1QueryLimit===1000,'the straightforward all-16 apply, closing acceptance proofs included, fits one invocation: '+applied.d1Queries);
 assert.deepEqual([applied.ok,applied.outcome,applied.writes,applied.provedWrites,applied.uncertainEffects,applied.stopped],[true,'complete',16,16,0,null]);
 assert.deepEqual(applied.counts,{applied:16,alreadyApplied:0,recoveredUnattributed:0,skipped:0,notAttempted:0,inFlight:0,notApplied:0,unknown:0,failed:0,settleFailed:0});
 assert.deepEqual([applied.readback.readable,applied.readback.failure,applied.readback.accepted,applied.readback.counts.applied],[true,null,true,16],'all 16 read applied NOW: receipt at the post-revision, row equal to the post-image, resolver current');
 assert.ok(applied.readback.items.every(item=>item.state==='applied'&&item.current.rowIsPostImage===true&&item.current.resolver==='noop'&&item.current.receipt==='applied'));
 for(const id of COHORT){
  assert.deepEqual(locRow(file,id),{status:'provisional',source:'tmdb',value:'Значение '+id,authority:null},id);
  assert.equal(revision(file,id),1,id+' one revision bump');
  assert.equal(revisionAt(file,id),pre.expect.planAt,id+' the revision is stamped with the approved plan time, never an older fixed one');
 }
 assert.equal(JSON.stringify([locRow(file,OTHER),revision(file,OTHER)]),otherBefore,'a Film outside the cohort is untouched');
 const done=reconcileReceipts(file);
 assert.deepEqual([done.length,done.every(row=>row.state==='applied'&&row.origin==='localization_reconciler'&&row.applied_revision===1)],[16,true]);
 assert.equal(keys(bucket).filter(isIntent).length,16,'16 immutable intent objects');
 assert.equal(keys(bucket).filter(isEvent).length,16,'16 applied outcome events');
 assert.ok(keys(bucket).every(key=>key.startsWith(PREFIX)),'only the isolated prefix is written');
 const text=JSON.stringify(applied);
 assert.ok(!text.includes('Значение')&&!text.includes(PREFIX)&&!text.includes('postImage'),'no value, key or intent body in the answer');
 const sample=await (await bucket.get(keys(bucket).find(isIntent))).json();
 assert.deepEqual([sample.plannedRevision,sample.postRevision,sample.runId,sample.at],[0,1,X.REPAIR_RUN_ID,pre.expect.planAt],'the recorded intent carries the approved plan time');
}

// ---- 6. Afterwards: nothing to do, a repeated apply is refused; the read-only modes leave a POPULATED checkpoint and D1 exactly as they were ----
{
 const after=await preflight(env);
 assert.deepEqual([after.decision,after.counts.applied,after.counts.eligible,after.expect.count],['nothing_to_do',16,0,0]);
 const snap=world(file),objects=snapBucket(bucket);
 const again=await tool(env,applyArgs(pre));
 assert.deepEqual([again.status,again.body.reason,again.body.writes],[409,'not_eligible',0]);
 const recover=await recoverOf(env);
 assert.equal(recover.items.length,16);
 assert.ok(recover.items.every(item=>item.recordedState==='applied'&&item.classification.state==='applied'&&item.classification.rowIsPostImage===true&&item.restore.state==='not_applied'&&item.restore.eligible===true&&/^[0-9a-f]{64}$/.test(item.restore.digest)));
 await preflight(env);
 assert.equal(world(file),snap,'the read-only modes write no D1 row and no receipt');assert.equal(snapBucket(bucket),objects,'and no R2 object');
 // Concurrent recovery: identical answers, no effect.
 const [a,b,c]=await Promise.all([recoverOf(env),recoverOf(env),recoverOf(env)]);
 assert.deepEqual([JSON.stringify(b),JSON.stringify(c)],[JSON.stringify(a),JSON.stringify(a)]);
 assert.equal(world(file),snap);assert.equal(snapBucket(bucket),objects);
}

// ---- 7. Restore: approved against a FRESH intent-specific proof and its own pins, exact recorded revision, once; a replay reports no new write ----
{
 const id='film:1XYA';
 const recover=await recoverOf(env);
 const good=restoreArgs(recover,id);
 for(const [patch,status,reason] of [[{expectedFilmPersonGeneration:undefined},400,'invalid_expected_film_person_generation'],[{expectedSchemaVersion:undefined},400,'invalid_expected_schema_version'],[{expectedOwnerReviewWrites:undefined},400,'invalid_expected_owner_review_writes'],[{expectedRestoreDigest:undefined},400,'invalid_expected_restore_digest'],[{expectedSchemaVersion:good.expectedSchemaVersion+1},409,'pins_mismatch'],[{expectedOwnerReviewGeneration:good.expectedOwnerReviewGeneration+1},409,'pins_mismatch'],[{expectedRestoreDigest:'0'.repeat(64)},409,'restore_proof_mismatch']]){
  const snap=world(file);
  const refused=await tool(env,{...good,...patch});
  assert.deepEqual([refused.status,refused.body.reason],[status,reason],JSON.stringify(patch));
  if(status===409)assert.equal(refused.body.writes,0);
  assert.equal(world(file),snap,JSON.stringify(patch)+' writes nothing');
 }
 const result=await tool(env,good);
 assert.deepEqual([result.status,result.body.ok,result.body.state,result.body.writes,result.body.settleError,result.body.alreadyApplied],[200,true,'restored',1,null,undefined]);
 assert.equal(locRow(file,id),null,'a null pre-image deletes the row the operation created');
 assert.equal(revision(file,id),2,'a restore bumps the revision');
 const after=await recoverOf(env);
 const item=after.items.find(entry=>entry.id===id);
 assert.deepEqual([item.recordedState,item.restore.state,item.restore.eligible],['restored','applied',false]);
 // The same call again: the restore is already applied under ITS OWN receipt, nothing is written and no new write is claimed.
 const snap=world(file);
 const replay=await tool(env,restoreArgs(after,id));
 assert.deepEqual([replay.status,replay.body.ok,replay.body.alreadyApplied,replay.body.writes],[200,true,true,0]);
 assert.equal(world(file),snap);
 assert.equal((await tool(env,good)).body.reason,'restore_proof_mismatch','the old proof does not authorize a second restore');
 const view=await preflight(env);
 assert.equal(view.items.find(entry=>entry.id===id).state,'restored');
 assert.equal(view.counts.eligible,0,'a restored Film is reported, never silently re-applied');
 // A concurrent legitimate change after the apply: the Film is reported moved and a restore refuses and erases nothing.
 const moved='film:27iE';
 exec(file,"UPDATE film_dimension SET value='Другое' WHERE film_id="+q(moved)+" AND dimension='localization';UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id="+q(moved));
 const snapMoved=dataWorld(file),applies=appliedReceipts(file);
 const movedRecover=await recoverOf(env);
 const movedItem=movedRecover.items.find(entry=>entry.id===moved);
 assert.deepEqual([movedItem.classification.state,movedItem.restore.eligible],['applied',false]);
 const refused=await tool(env,restoreArgs(movedRecover,moved));
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'localization_restore_moved',0]);
 assert.equal(dataWorld(file),snapMoved,'another writer is never erased');assert.equal(appliedReceipts(file),applies);
 const blocked=await preflight(env);
 assert.deepEqual([blocked.items.find(entry=>entry.id===moved).state,blocked.decision],['applied_moved','blocked'],'a later legitimate change is reported, never complete');
 const unrecorded=fresh();
 const none=await tool(unrecorded.env,{mode:'restore',confirmGo:true,filmId:'film:xG0M',expectedFilmPersonGeneration:2,expectedSchemaVersion:Number(one(unrecorded.file,'SELECT version FROM schema_contract WHERE id=1')),expectedOwnerReviewGeneration:1,expectedOwnerReviewWrites:(await preflight(unrecorded.env)).pins.ownerReviewWrites,expectedRestoreDigest:'a'.repeat(64)});
 assert.deepEqual([none.status,none.body.reason,none.body.writes],[409,'no_applied_intent',0],'a Film with no recorded applied intent has nothing to restore');
}

// ---- 7a. A restore is a deliberate ROLLBACK, not a repair: reported, never reapplied, never counted complete; a later change to it is reported and nothing is overwritten ----
{
 // A partial run, one Film restored, the rest resumed: the cohort is never complete while a deliberately restored stale Film remains.
 const f=fresh();const p=await preflight(f.env);
 let count=0;
 const stopAt=before(f.file,f.bucket,statements=>{if(statements.some(isWrite)&&!statements.some(isReservation)&&++count===6)exec(f.file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(COHORT[5])+",1,'"+T3+"')");});
 const partial=await applyAll(stopAt,p);
 assert.deepEqual([partial.ok,partial.counts.applied,partial.stopped],[false,5,'moved']);
 const rec=await recoverOf(f.env);
 const rolled=await tool(f.env,restoreArgs(rec,COHORT[0]));
 assert.deepEqual([rolled.status,rolled.body.ok,rolled.body.writes],[200,true,1]);
 assert.equal(locRow(f.file,COHORT[0]),null);
 const view=await preflight(f.env);
 assert.equal(view.items[0].state,'restored','a deliberate rollback, proved now by its own receipt, the post-restore revision and the pre-image row');
 assert.deepEqual(view.items[0].current,{receipt:'applied',revision:2,rowIsPreImage:true});
 const resumed=await applyAll(f.env,view);
 assert.equal(resumed.counts.restored===undefined,true);
 assert.deepEqual([resumed.ok,resumed.outcome,resumed.readback.accepted,resumed.readback.rolledBack],[false,'partial',false,1],'never complete while a restored stale Film remains');
 assert.equal(locRow(f.file,COHORT[0]),null,'a restored Film is not reapplied automatically');
 // A later legitimate change to the restored Film: reported (restored_moved), blocks, nothing is overwritten.
 exec(f.file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(COHORT[0])+",'localization','reviewed','dictionary','verified',NULL,'Новое','dictionary',0,'keep_reviewed','"+T3+"');UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id="+q(COHORT[0]));
 const snap=dataWorld(f.file);
 const moved=await preflight(f.env);
 assert.deepEqual([moved.items[0].state,moved.decision],['restored_moved','blocked']);
 assert.equal(moved.items[0].current.rowIsPreImage,false);
 const refused=await tool(f.env,{...applyArgs(moved),expectedCount:1});
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'not_eligible',0]);
 assert.equal(dataWorld(f.file),snap,'the later change is neither overwritten nor reapplied');
}

// ---- 7b. A cohort Film that is already current is skipped, untouched; if every Film is current the operation is a proved no-op ----
{
 const f=database();
 const P=await load('film-localization-projection.js');
 for(const id of COHORT)if(id!=='film:xG0M')staleFilm(f,id);
 seedFilm(f,'film:xG0M',tmdbOf('film:xG0M'));
 const e=envOf(f);
 const sources=[{source:'tmdb',value:'Текущее',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(e,{id:'film:xG0M',expectedRevision:0,at:T,requestId:'req-current',sources,inputs:await P.readProjectionInputs(e,'film:xG0M',sources)});
 const current=JSON.stringify([locRow(f,'film:xG0M'),revision(f,'film:xG0M')]);
 const p=await preflight(e);
 assert.deepEqual([p.decision,p.counts.eligible,p.counts.noop,p.expect.count],['eligible',15,1,15]);
 const r=await applyAll(e,p);
 assert.deepEqual([r.ok,r.writes,r.counts.skipped,r.counts.applied,r.readback.accepted],[true,15,1,15,true]);
 assert.equal(JSON.stringify([locRow(f,'film:xG0M'),revision(f,'film:xG0M')]),current,'the current Film is untouched');
 const allCurrent=database();
 for(const id of COHORT){seedFilm(allCurrent,id,tmdbOf(id));const ee=envOf(allCurrent);await P.writeFilmLocalizationProjection(ee,{id,expectedRevision:0,at:T,requestId:'req-'+id,sources,inputs:await P.readProjectionInputs(ee,id,sources)});}
 const none=await preflight(envOf(allCurrent));
 assert.deepEqual([none.decision,none.counts.noop,none.expect.count],['nothing_to_do',16,0]);
}

// ---- 8. Checkpoint refusal: nothing is written for a Film whose intent is not durably recorded ----
{
 const f=database();seedCohort(f);
 const inner=new MemoryBucket();
 const failing={put:async()=>{throw new Error('R2 down');},get:async key=>inner.get(key),list:async o=>inner.list(o)};
 const e={DB:d1Standin(f),BUCKET:failing};
 const p=await preflight(e),snap=world(f);
 const result=await applyAll(e,p);
 assert.deepEqual([result.ok,result.outcome,result.writes,result.stopped,result.counts.failed,result.counts.notAttempted],[false,'partial',0,'previous_film_failed',1,15]);
 assert.equal(result.items[0].reason,'localization_checkpoint_failed');
 assert.equal(world(f),snap,'a refused record writes nothing');
}

// ---- 9. The checkpoint: conditional create, full readback, idempotence, conflict, unreadable, validated history ----
{
 const f=fresh();
 const mk=b=>X.repairCheckpoint({BUCKET:b});
 const {readReconcileIntent}=await load('film-localization-reconciler.js');
 const {intent}=await readReconcileIntent(f.env,COHORT[0],{runId:X.REPAIR_RUN_ID,at:T3});
 assert.ok(intent);
 const b=new MemoryBucket();let port=mk(b);
 await port.record(intent);await port.record(intent);
 assert.equal(b.objects.size,1,'the same intent twice is one object');
 const lateB=new MemoryBucket();const late=mk({put:async(...a)=>{await lateB.put(...a);throw new Error('timeout');},get:k=>lateB.get(k),list:o=>lateB.list(o)});
 await late.record(intent);assert.equal(lateB.objects.size,1,'a timeout AFTER a successful put reads the object back and succeeds');
 const lost=mk({put:async()=>{throw new Error('timeout');},get:async()=>null,list:async()=>({objects:[],truncated:false})});
 await assert.rejects(()=>lost.record(intent),error=>error.code==='checkpoint_not_recorded');
 const key=[...b.objects.keys()][0];
 b.objects.set(key,{text:JSON.stringify({...JSON.parse(b.objects.get(key).text),at:'2026-11-29T00:00:00.000Z'}),customMetadata:{}});
 await assert.rejects(()=>port.record(intent),error=>error.code==='checkpoint_conflict');
 const unreadable=mk({put:async()=>null,get:async()=>{throw new Error('R2 read');},list:async()=>({objects:[],truncated:false})});
 await assert.rejects(()=>unreadable.record(intent),error=>error.code==='checkpoint_unavailable');
 await assert.rejects(()=>mk(new MemoryBucket()).record({...intent,runId:'other-run'}),error=>['film_person_invalid','checkpoint_scope'].includes(error.code));
 await assert.rejects(()=>mk(new MemoryBucket()).record({...intent,at:'yesterday'}),error=>['film_person_invalid','checkpoint_scope'].includes(error.code));
 const s=new MemoryBucket();port=mk(s);
 await assert.rejects(()=>port.settle(intent,{state:'applied'}),error=>error.code==='checkpoint_not_recorded','no settlement without a recorded intent');
 await port.record(intent);
 await assert.rejects(()=>port.settle(intent,{state:'recorded'}),error=>error.code==='checkpoint_scope');
 await assert.rejects(()=>port.settle(intent,{state:'applied',via:'elsewhere'}),error=>error.code==='checkpoint_scope');
 await port.settle(intent,{state:'unknown',errorClass:'network'});
 await port.settle(intent,{state:'unknown',errorClass:'network'});
 assert.equal([...s.objects.keys()].filter(isEvent).length,1,'the same outcome twice is one event');
 await port.settle(intent,{state:'applied',via:'recover'});
 await assert.rejects(()=>port.settle(intent,{state:'not_applied'}),error=>error.code==='checkpoint_transition_refused','an applied intent cannot become not_applied');
 await port.settle(intent,{state:'restored',via:'restore'});
 await assert.rejects(()=>port.settle(intent,{state:'applied'}),error=>error.code==='checkpoint_transition_refused','restored is terminal');
 assert.deepEqual([...s.objects.keys()].filter(isEvent).map(k=>k.slice(-9)),['0001.json','0002.json','0003.json'],'one key per sequence');
 const trunc=mk({put:async()=>({}),get:async()=>null,list:async()=>({objects:[],truncated:true})});
 await assert.rejects(()=>trunc.settle(intent,{state:'applied'}),error=>['checkpoint_listing_truncated','checkpoint_not_recorded'].includes(error.code));
 // The stored history is validated against ITS intent: a foreign digest, an impossible transition, a wrong revision, an unexpected key, a version or a gap is corrupt, never trusted.
 const eventKeys=[...s.objects.keys()].filter(isEvent);
 const copyOf=()=>{const copy=new MemoryBucket();for(const [k,v] of s.objects)copy.objects.set(k,{...v});return copy;};
 const tamper=(index,patch)=>{const copy=copyOf();const k=eventKeys[index];copy.objects.set(k,{text:JSON.stringify({...JSON.parse(copy.objects.get(k).text),...patch}),customMetadata:{}});return copy;};
 const outcome=async bucketx=>{try{await mk(bucketx).settle(intent,{state:'restored',via:'restore'});return 'ok';}catch(error){return error.code;}};
 for(const [index,patch] of [[0,{digest:'0'.repeat(64)}],[0,{requestId:'x:y'}],[1,{state:'not_applied'}],[1,{revision:99}],[0,{extra:1}],[0,{version:2}],[1,{via:'elsewhere'}]])assert.equal(await outcome(tamper(index,patch)),'checkpoint_corrupt',JSON.stringify([index,patch]));
 const gap=new MemoryBucket();for(const [k,v] of s.objects)if(!k.endsWith('0002.json'))gap.objects.set(k,{...v});
 assert.equal(await outcome(gap),'checkpoint_corrupt','a gap in the sequence is corrupt');
}

// ---- 10. A lost reply after the commit: the effect is proved from the receipt IN THE SAME CALL, counted once, and the run stops ----
{
 const f=fresh();
 const pre1=await preflight(f.env);
 const first=await applyAll(lossy(f.file,f.bucket,/INSERT INTO film_dimension/),pre1);
 assert.deepEqual([first.ok,first.outcome,first.stopped],[false,'partial','recovered_after_lost_reply']);
 assert.deepEqual([first.counts.recoveredUnattributed,first.counts.applied,first.counts.unknown,first.counts.notAttempted,first.writes,first.provedWrites,first.uncertainEffects],[1,0,0,15,null,0,1],'the effect is proved from the receipt but cannot be attributed to this call: writes is null, not a new write');
 assert.equal(first.items[0].state,'recovered_applied');
 assert.equal(revision(f.file,COHORT[0]),1,'the write DID commit before the reply was lost');
 assert.equal(reconcileReceipts(f.file).length,1);
 assert.equal([...f.bucket.objects.keys()].filter(isEvent).length,2,'unknown, then applied');
 const mid=await preflight(f.env);
 assert.deepEqual([mid.decision,mid.counts.applied,mid.counts.eligible,mid.expect.count],['eligible',1,15,15]);
 const second=await applyAll(f.env,mid);
 assert.deepEqual([second.ok,second.outcome,second.counts.applied,second.writes],[true,'complete',15,15]);
 for(const id of COHORT)assert.equal(revision(f.file,id),1,id+' written exactly once');
 assert.deepEqual([(await preflight(f.env)).decision,reconcileReceipts(f.file).length],['nothing_to_do',16]);
}

// ---- 11. An authority pin that moves at any boundary is refused: after the record, at the reservation, before the domain commit; nothing lands under an unapproved pin ----
{
 // 11a: the pin moves right after the intent was recorded and BEFORE the receipt is reserved: no receipt is created at all.
 const f=fresh();const flk=flaky(f.bucket);
 const p=await preflight({DB:d1Standin(f.file),BUCKET:flk});
 flk.flags.afterIntent=()=>exec(f.file,'UPDATE schema_contract SET version=version+1 WHERE id=1');
 const snap=dataWorld(f.file);
 const result=await applyAll({DB:d1Standin(f.file),BUCKET:flk},p);
 assert.deepEqual([result.ok,result.stopped,result.counts.notApplied,result.counts.unknown,result.writes],[false,'no_effect',1,0,0]);
 assert.equal(dataWorld(f.file),snap,'no data changed');
 assert.deepEqual(reconcileReceipts(f.file),[],'no D1 reservation under an unapproved pin: only the harmless recorded intent exists');
 assert.equal([...f.bucket.objects.keys()].filter(isIntent).length,1,'the recorded intent is a recovery artifact, not an effect');
 assert.ok(result.items.slice(1).every(item=>item.state==='not_attempted'));
 const recover=await recoverOf(f.env);
 assert.deepEqual(recover.items.map(item=>[item.recordedState,item.classification.state]),[['not_applied','not_applied']]);
 // 11b: the pin moves AT the reservation batch itself.
 const g=fresh();const pg=await preflight(g.env);
 const atReservation=before(g.file,g.bucket,statements=>{if(statements.some(isReservation))exec(g.file,'UPDATE owner_review_authority SET generation=generation+1 WHERE id=1');});
 const snapG=dataWorld(g.file);
 const rg=await applyAll(atReservation,pg);
 assert.deepEqual([rg.ok,rg.counts.notApplied,rg.writes],[false,1,0]);
 assert.deepEqual(reconcileReceipts(g.file),[],'the reservation batch asserted the approved owner-review generation and refused');
 assert.equal(dataWorld(g.file),snapG);
 // 11c: the pin moves AFTER the reservation and before the domain commit: the domain batch refuses, nothing lands, no applied receipt.
 const h=fresh();const ph=await preflight(h.env);
 const atCommit=before(h.file,h.bucket,statements=>{if(statements.some(isWrite)&&!statements.some(isReservation))exec(h.file,'UPDATE schema_contract SET version=version+1 WHERE id=1');});
 const snapH=dataWorld(h.file);
 const rh=await applyAll(atCommit,ph);
 assert.deepEqual([rh.ok,rh.counts.notApplied,rh.counts.unknown,rh.writes,rh.stopped],[false,1,0,0,'no_effect']);
 assert.equal(dataWorld(h.file),snapH,'the domain batch refused under the moved schema pin');
 assert.equal(appliedReceipts(h.file),0);
 assert.ok(reconcileReceipts(h.file).every(row=>row.state!=='applied'),'at most the non-applied reservation of the attempt itself');
 // The schema pin only moves forward: the owner approves anew from a fresh preflight at a later plan time (a new plan time is a new intent, so the earlier attempt's backoff is not in the way).
 const later=()=>'2026-11-26T13:00:00.000Z';
 const laterTool=(environment,args)=>X.handleFilmLocalizationRepairTool(environment,args,{now:later});
 const fresh2=(await laterTool(h.env,{})).body;
 assert.deepEqual([fresh2.decision,fresh2.counts.eligible,fresh2.expect.schemaVersion>ph.expect.schemaVersion],['eligible',16,true]);
 const retry=(await laterTool(h.env,applyArgs(fresh2))).body;
 assert.deepEqual([retry.ok,retry.writes],[true,16]);
 for(const id of COHORT)assert.equal(revision(h.file,id),1,id+' written exactly once');
}

// ---- 12. A Film that moved after the intent was recorded is never overwritten; no blind retry ----
{
 const f=fresh();const p=await preflight(f.env);
 let bumped=false;
 const moving=before(f.file,f.bucket,statements=>{if(!bumped&&statements.some(isWrite)&&!statements.some(isReservation)){bumped=true;exec(f.file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(COHORT[0])+",1,'"+T3+"')");}});
 const result=await applyAll(moving,p);
 assert.deepEqual([result.ok,result.writes,result.stopped,result.counts.notApplied],[false,0,'moved',1]);
 assert.equal(locRow(f.file,COHORT[0]),null);
 assert.equal(stateCount(result,'not_attempted'),15,'nothing after the stopping Film is attempted');
}

// ---- 13. A settle failure AFTER the mutation committed is counted as a write, stops the run and is completed by the next apply ----
{
 const f=fresh();const flk=flaky(f.bucket);const e={DB:d1Standin(f.file),BUCKET:flk};
 const p=await preflight(e);
 flk.flags.failEvents=true;
 const first=await applyAll(e,p);
 assert.deepEqual([first.ok,first.stopped,first.counts.applied,first.counts.settleFailed,first.counts.failed,first.writes,first.provedWrites],[false,'settle_failed',1,1,0,1,1],'the committed write is counted although its settlement failed');
 assert.equal(first.items[0].state,'applied_unsettled');
 assert.equal(revision(f.file,COHORT[0]),1);
 flk.flags.failEvents=false;
 const view=await preflight(e);
 assert.deepEqual([view.items[0].state,view.items[0].recordedState,view.counts.recorded,view.expect.count],['recorded','recorded',1,16],'R2 has no event: the intent is recorded, to be recovered, never re-derived');
 const rec=await recoverOf(e);
 assert.deepEqual(rec.items.map(item=>[item.recordedState,item.classification.state]),[['recorded','applied']]);
 const second=await applyAll(e,view);
 assert.deepEqual([second.ok,second.counts.alreadyApplied,second.counts.applied,second.writes,second.provedWrites],[true,1,15,15,15],'the earlier write is settled, not written again, and not claimed as a new write');
 for(const id of COHORT)assert.equal(revision(f.file,id),1);
 assert.equal([...f.bucket.objects.keys()].filter(isEvent).length,16);
}

// ---- 14. Current acceptance: a partial run followed by a legitimate update, a receipt that no longer matches the row, an unproved history, an unreadable readback ----
{
 // 14a: Film A applied, the run stops at B; another legitimate writer then changes A. The next attempt reports it and can never be complete.
 const f=fresh();const p=await preflight(f.env);
 let count=0;
 const stopAtSecond=before(f.file,f.bucket,statements=>{if(statements.some(isWrite)&&!statements.some(isReservation)&&++count===2)exec(f.file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(COHORT[1])+",1,'"+T3+"')");});
 const partial=await applyAll(stopAtSecond,p);
 assert.deepEqual([partial.ok,partial.counts.applied,partial.stopped,partial.writes],[false,1,'moved',1]);
 exec(f.file,"UPDATE film_dimension SET value='Новое' WHERE film_id="+q(COHORT[0])+" AND dimension='localization';UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id="+q(COHORT[0]));
 const snap=dataWorld(f.file);
 const view=await preflight(f.env);
 assert.deepEqual([view.items[0].state,view.items[0].current.rowIsPostImage,view.counts.applied_moved,view.decision],['applied_moved',false,1,'blocked'],'reported, not silently skipped');
 const refused=await tool(f.env,applyArgs(view));
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'not_eligible',0]);
 assert.equal(dataWorld(f.file),snap,'a legitimate later update is neither overwritten nor permission to overwrite');
 // 14b: the receipt is applied at its revision but the row no longer equals the post-image (no revision change).
 const g=fresh();const done=await applyAll(g.env);
 assert.equal(done.ok,true);
 exec(g.file,"UPDATE film_dimension SET value='Подмена' WHERE film_id="+q(COHORT[2])+" AND dimension='localization'");
 const mismatch=await preflight(g.env);
 assert.deepEqual([mismatch.items[2].state,mismatch.items[2].current.receipt,mismatch.items[2].current.rowIsPostImage,mismatch.decision],['applied_moved','applied',false,'blocked']);
 // 14c: the history says applied, D1 does not prove it: never trusted.
 const h=fresh();const hp=await preflight(h.env);
 const flk=flaky(h.bucket);flk.flags.afterIntent=()=>exec(h.file,'UPDATE schema_contract SET version=version+1 WHERE id=1');
 await applyAll({DB:d1Standin(h.file),BUCKET:flk},hp);
 const intent=await (await h.bucket.get(keys(h.bucket).find(isIntent))).json();
 const existing=keys(h.bucket).filter(key=>key.includes('/events/'+intent.requestId+'/'));
 const next=existing.length+1;
 await h.bucket.put(keys(h.bucket).find(isEvent).replace(/\d{4}\.json$/,String(next).padStart(4,'0')+'.json'),JSON.stringify(forged(intent,next,'applied')),{onlyIf:{etagDoesNotMatch:'*'}});
 const unproved=await preflight(h.env);
 assert.deepEqual([unproved.items[0].state,unproved.items[0].current.receipt,unproved.decision],['applied_unproved','not_applied','blocked'],'an R2 applied event is not proof of a D1 effect');
 // 14d: a readback that cannot be read is not success.
 const k=fresh();const flk2=flaky(k.bucket);const e2={DB:d1Standin(k.file),BUCKET:flk2};
 const kp=await preflight(e2);
 let writes=0;
 const countingDb=d1Standin(k.file),realBatch=countingDb.batch.bind(countingDb);
 countingDb.batch=async statements=>{const result=await realBatch(statements);if(statements.some(isWrite)&&!statements.some(isReservation)&&++writes===16)flk2.flags.failList=true;return result;};
 const unreadable=await applyAll({DB:countingDb,BUCKET:flk2},kp);
 assert.deepEqual([unreadable.ok,unreadable.outcome,unreadable.counts.applied,unreadable.readback.readable,unreadable.readback.accepted],[false,'partial',16,false,false],'all 16 committed, but without a readable current acceptance the run is not complete');
}

// ---- 15. Restore under uncertainty: a lost reply, a settle failure, a pin that moves at the restore reservation ----
{
 const id=COHORT[3];
 // 15a: the restore commits and the reply is lost: proved from ITS OWN receipt, counted once, and a replay writes nothing.
 const a=fresh();await applyAll(a.env);
 const ra=await recoverOf(a.env);
 const lostResult=await tool(lossy(a.file,a.bucket,/DELETE FROM film_dimension/),restoreArgs(ra,id));
 assert.deepEqual([lostResult.status,lostResult.body.ok,lostResult.body.writes,lostResult.body.recoveredAfterError,lostResult.body.effectProved,lostResult.body.state],[200,true,null,true,true,'restored'],'proved from its own receipt, not attributable to this call');
 assert.equal(locRow(a.file,id),null);assert.equal(revision(a.file,id),2);
 const after=await recoverOf(a.env);
 const replay=await tool(a.env,restoreArgs(after,id));
 assert.deepEqual([replay.body.ok,replay.body.alreadyApplied,replay.body.writes],[true,true,0],'a repeated restore never reports a new write');
 assert.equal(revision(a.file,id),2);
 // 15b: the restore commits, the settlement fails: the write is counted, the error is reported, the next call completes the settlement without a second write.
 const b=fresh();const fb=flaky(b.bucket);const eb={DB:d1Standin(b.file),BUCKET:fb};
 await applyAll(eb);
 const rb=await recoverOf(eb);
 fb.flags.failEvents=true;
 const unsettled=await tool(eb,restoreArgs(rb,id));
 assert.deepEqual([unsettled.status,unsettled.body.ok,unsettled.body.writes,typeof unsettled.body.settleError],[200,false,1,'string'],'committed but not durably settled');
 fb.flags.failEvents=false;
 const mid=await recoverOf(eb);
 const midItem=mid.items.find(entry=>entry.id===id);
 assert.deepEqual([midItem.recordedState,midItem.restore.state],['applied','applied'],'the restore receipt proves the effect that R2 does not yet record');
 const completed=await tool(eb,restoreArgs(mid,id));
 assert.deepEqual([completed.body.ok,completed.body.alreadyApplied,completed.body.writes],[true,true,0]);
 assert.equal(revision(b.file,id),2,'one restore only');
 assert.equal((await recoverOf(eb)).items.find(entry=>entry.id===id).recordedState,'restored');
 // 15c: a pin moves at the restore receipt reservation: nothing lands and no restore receipt exists.
 const c=fresh();await applyAll(c.env);
 const rc=await recoverOf(c.env);
 const moving=before(c.file,c.bucket,statements=>{if(statements.some(isReservation))exec(c.file,'UPDATE schema_contract SET version=version+1 WHERE id=1');});
 const snapC=dataWorld(c.file),receiptsBefore=reconcileReceipts(c.file).length;
 const refusedRestore=await tool(moving,restoreArgs(rc,id));
 assert.deepEqual([refusedRestore.status,refusedRestore.body.ok,refusedRestore.body.writes],[409,false,0]);
 assert.equal(dataWorld(c.file),snapC);assert.equal(reconcileReceipts(c.file).length,receiptsBefore,'no restore reservation under an unapproved pin');
 // A pin moved between the proof and the restore is refused before anything is attempted.
 const stale=await tool(c.env,restoreArgs(rc,id));
 assert.deepEqual([stale.status,stale.body.reason,stale.body.writes],[409,'pins_mismatch',0]);
}

// ---- 16. Plan time: never earlier than a cohort revision; a Film's revision timestamp is not backdated ----
{
 const f=fresh();
 exec(f.file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(COHORT[0])+",1,'2026-12-01T00:00:00.000Z')");
 const behind=await preflight(f.env);
 assert.deepEqual([behind.decision,behind.failure,behind.expect],['unknown','plan_time_behind_revision',null],'a plan time earlier than a revision of the cohort is refused');
 const g=fresh();
 exec(g.file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(COHORT[0])+",1,'"+T1+"')");
 const p=await preflight(g.env);
 assert.equal(p.items[0].plannedRevision,1);
 const r=await applyAll(g.env,p);
 assert.equal(r.ok,true);
 assert.deepEqual([revision(g.file,COHORT[0]),revisionAt(g.file,COHORT[0])>T1,revisionAt(g.file,COHORT[0])],[2,true,p.expect.planAt],'a later revision carries a later timestamp');
}

// ---- 17. A corrupt checkpoint: the read-only modes report it and write nothing; apply and restore refuse ----
{
 const f=fresh();await applyAll(f.env);
 const intentKeyOf=keys(f.bucket).find(isIntent);
 const tampered=new MemoryBucket();for(const [k,v] of f.bucket.objects)tampered.objects.set(k,{...v});
 const eventKey=keys(tampered).find(isEvent);
 tampered.objects.set(eventKey,{text:JSON.stringify({...JSON.parse(tampered.objects.get(eventKey).text),digest:'0'.repeat(64)}),customMetadata:{}});
 const e=envOf(f.file,tampered);
 const version=Number(one(f.file,'SELECT version FROM schema_contract WHERE id=1'));
 const snap=world(f.file),objects=snapBucket(tampered);
 const view=await tool(e,{});
 assert.deepEqual([view.status,view.body.decision,view.body.failure,view.body.expect],[200,'unknown','checkpoint_corrupt',null]);
 const rec=await tool(e,{mode:'recover'});
 assert.deepEqual([rec.status,rec.body.ok,rec.body.reason],[503,false,'checkpoint_corrupt']);
 const apply=await tool(e,{mode:'apply',confirmGo:true,expectedFilmPersonGeneration:2,expectedSchemaVersion:version,expectedOwnerReviewGeneration:1,expectedOwnerReviewWrites:'open',expectedPlanAt:T3,expectedCount:1,expectedDigest:'a'.repeat(64)});
 assert.deepEqual([apply.status,apply.body.reason,apply.body.writes],[409,'not_eligible',0]);
 const restore=await tool(e,{mode:'restore',confirmGo:true,filmId:COHORT[0],expectedFilmPersonGeneration:2,expectedSchemaVersion:version,expectedOwnerReviewGeneration:1,expectedOwnerReviewWrites:'open',expectedRestoreDigest:'a'.repeat(64)});
 assert.deepEqual([restore.status,restore.body.reason,restore.body.writes],[503,'checkpoint_corrupt',0]);
 assert.equal(world(f.file),snap);assert.equal(snapBucket(tampered),objects,'a corrupt checkpoint is neither repaired nor extended');
 // An intent outside the cohort in the prefix is corrupt too.
 const alien=new MemoryBucket();for(const [k,v] of f.bucket.objects)alien.objects.set(k,{...v});
 alien.objects.set(intentKeyOf,{text:JSON.stringify({...JSON.parse(alien.objects.get(intentKeyOf).text),id:'film:tmdb:9999'}),customMetadata:{}});
 const alienView=await tool(envOf(f.file,alien),{});
 assert.equal(alienView.body.decision,'unknown');
 assert.ok(['film_person_invalid','checkpoint_corrupt'].includes(alienView.body.failure),alienView.body.failure);
}

// ---- 19. The REAL D1 budget (1,000 queries per Worker invocation, a batch counting once): the meter enforces it, a call stops safely before it, and the cohort still completes through the recorded intents ----
{
 const call=(environment,args,queryLimit)=>X.handleFilmLocalizationRepairTool(environment,args,{now:clock,queryLimit});
 // A limit that cannot even prove the cohort: unknown, no pins to approve, nothing written.
 const t=fresh();const snapT=world(t.file);
 const tiny=(await call(t.env,{},120)).body;
 assert.deepEqual([tiny.decision,tiny.failure,tiny.expect],['unknown','d1_query_budget',null]);
 assert.ok(tiny.d1Queries<=120,'the meter refuses locally before anything beyond the limit is sent');
 assert.equal(world(t.file),snapT);assert.equal(t.bucket.objects.size,0);
 // A limit that fits the proof but not all 16 writes: the call stops BEFORE the Film that could pass the limit, loses no effect, claims no completion, and a fresh preflight continues.
 const g=fresh();const LIMIT=620;
 const pg=(await call(g.env,{},LIMIT)).body;
 assert.equal(pg.decision,'eligible');
 let last=(await call(g.env,applyArgs(pg),LIMIT)).body;
 const first=last;
 assert.deepEqual([first.ok,first.outcome,first.stopped],[false,'partial','d1_query_budget']);
 assert.ok(first.d1Queries<=LIMIT,'never above the limit: '+first.d1Queries);
 assert.ok(first.counts.applied>=1&&first.counts.applied<16,'partial progress: '+first.counts.applied);
 assert.equal(first.counts.notAttempted,16-first.counts.applied);
 assert.equal(COHORT.filter(id=>revision(g.file,id)===1).length,first.counts.applied,'no lost effect: every counted write is a committed revision');
 assert.deepEqual([first.readback.readable,first.readback.accepted,first.readback.counts.applied],[true,false,first.counts.applied],'the closing acceptance proof still fit, and it does not claim completion');
 assert.ok(first.items.filter(item=>item.state==='not_attempted').every(item=>item.reason==='d1_query_budget'));
 let rounds=1;
 while(!last.ok&&rounds<14){
  const next=(await call(g.env,{},LIMIT)).body;
  last=(await call(g.env,applyArgs(next),LIMIT)).body;
  assert.ok(last.d1Queries<=LIMIT);rounds++;
 }
 assert.deepEqual([last.ok,last.readback.accepted,rounds>1],[true,true,true],'the exact 16-id cohort completes through fresh preflights over the recorded intents');
 for(const id of COHORT)assert.equal(revision(g.file,id),1,id+' written exactly once across the continuations');
 assert.equal(reconcileReceipts(g.file).filter(row=>row.state==='applied').length,16);
 assert.equal(keys(g.bucket).filter(isIntent).length,16,'one intent per Film, however many continuations');
}

// ---- 20. Overlapping calls and attempts in flight: replays are not writes, an in-flight attempt is never a definite no effect, and no fresh intent is derived over it ----
{
 // 20a: two calls on the same approved plan both derive the same fresh intents before either has recorded one; the second completes while the first is paused before recording its first intent. One domain
 // mutation per Film, and the first call claims none of them.
 const o=fresh();const flo=flaky(o.bucket);const po=await preflight({DB:d1Standin(o.file),BUCKET:flo});
 let nested=null;
 flo.flags.beforeIntent=async()=>{nested=(await tool(envOf(o.file,o.bucket),applyArgs(po))).body;};
 const firstCall=await applyAll({DB:d1Standin(o.file),BUCKET:flo},po);
 assert.deepEqual([nested.ok,nested.writes,nested.counts.applied],[true,16,16]);
 assert.deepEqual([firstCall.counts.applied,firstCall.counts.alreadyApplied,firstCall.writes,firstCall.uncertainEffects,firstCall.ok],[0,16,0,0,true],'the replay of an existing effect is not this call\'s write');
 for(const id of COHORT)assert.equal(revision(o.file,id),1,id+' mutated once');
 assert.equal(reconcileReceipts(o.file).length,16);assert.equal(keys(o.bucket).filter(isIntent).length,16,'the same intent was recorded idempotently, never twice');
 // 20b: the same for a restore: a replay of the other call's restore reports alreadyApplied and no write.
 const id=COHORT[4];
 const r=fresh();await applyAll(r.env);const rr=await recoverOf(r.env);
 let nestedRestore=null,firedRestore=false;
 const overlappedRestore=before(r.file,r.bucket,async statements=>{if(!firedRestore&&statements.some(isReservation)){firedRestore=true;nestedRestore=(await tool(envOf(r.file,r.bucket),restoreArgs(rr,id))).body;}});
 const firstRestore=(await tool(overlappedRestore,restoreArgs(rr,id))).body;
 assert.deepEqual([nestedRestore.ok,nestedRestore.writes],[true,1]);
 assert.deepEqual([firstRestore.ok,firstRestore.alreadyApplied,firstRestore.writes],[true,true,0]);
 assert.equal(revision(r.file,id),2,'one restore only');
 // 20c: an attempt that crashed after the reservation (its receipt stays pending): in flight, never a definite no effect, no terminal event, no fresh intent; once the attempt window has passed it is resumed with the SAME identity.
 const c=fresh();const pc=await preflight(c.env);
 let dead=false;
 const crashing=before(c.file,c.bucket,statements=>{if(!dead&&statements.some(isWrite)&&!statements.some(isReservation))dead=true;if(dead)throw new Error('D1_ERROR: the Worker died');});
 const crashed=await applyAll(crashing,pc);
 assert.deepEqual([crashed.ok,crashed.stopped,crashed.counts.inFlight,crashed.counts.notApplied,crashed.writes,crashed.uncertainEffects],[false,'in_flight',1,0,null,1]);
 assert.equal(crashed.items[0].state,'in_flight');
 assert.equal(locRow(c.file,COHORT[0]),null);assert.equal(revision(c.file,COHORT[0]),0);
 assert.deepEqual(reconcileReceipts(c.file).map(row=>row.state),['pending'],'the reservation of the dead attempt');
 const intentKey0=keys(c.bucket).find(isIntent);
 const events0=keys(c.bucket).filter(key=>isEvent(key));
 assert.equal(events0.length,1,'only the non-terminal unknown event: no terminal-looking not_applied was appended');
 assert.equal((await (await c.bucket.get(events0[0])).json()).state,'unknown');
 const rec=await recoverOf(c.env);
 assert.deepEqual([rec.items[0].classification.state,rec.items[0].classification.receiptState],['not_applied','pending'],'unchanged row, but the attempt is not over');
 const view=await preflight(c.env);
 assert.deepEqual([view.items[0].state,view.decision,view.counts.in_flight,view.counts.eligible],['in_flight','blocked',1,15]);
 const refused=await tool(c.env,applyArgs(view));
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'not_eligible',0]);
 assert.equal(keys(c.bucket).filter(isIntent).length,1,'no fresh intent over the in-flight one');
 // Past the attempt window the same identity is reconciled and resumed.
 const later=()=>'2026-11-26T13:00:00.000Z';
 const atLater=(environment,args)=>X.handleFilmLocalizationRepairTool(environment,args,{now:later});
 const due=(await atLater(c.env,{})).body;
 assert.deepEqual([due.items[0].state,due.decision],['recorded','eligible']);
 const resumed=(await atLater(c.env,applyArgs(due))).body;
 assert.deepEqual([resumed.ok,resumed.counts.inFlight,resumed.counts.unknown],[true,0,0]);
 for(const filmId of COHORT)assert.equal(revision(c.file,filmId),1,filmId+' written exactly once');
 assert.equal(reconcileReceipts(c.file).filter(row=>row.target_id===COHORT[0]).length,1,'the same receipt identity was resumed');
 assert.equal(keys(c.bucket).filter(isIntent).length,16);
 assert.ok(keys(c.bucket).includes(intentKey0));
}

// ---- 18. No migration, table, bucket or flag: the module touches only the existing isolated R2 prefix; the Worker bundle reaches it through the one owner-only MCP tool ----
{
 const source=fs.readFileSync('src/film-localization-repair.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\.delete\(|\.head\(/.test(source),'the operation never deletes an object');
 assert.ok(!/CREATE TABLE|ALTER TABLE|DROP /i.test(source));
 assert.ok(!/REPAIR_AT/.test(source),'no hard-coded plan time');
 assert.ok(!chain.some(name=>fs.readFileSync('migrations/'+name,'utf8').includes('film-localization-repair')));
 assert.ok(!/WORKFLOW|QUEUE|scheduled\(|cron/i.test(source));
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(build.includes("scopedImports('src/film-localization-repair.js','FilmLocalizationRepair'"),'the build bundles the operation');
 const mcp=fs.readFileSync('src/mcp.js','utf8');
 assert.ok(mcp.includes('FilmLocalizationRepair.handleFilmLocalizationRepairTool(env,args)'),'the owner-only MCP tool calls the operation');
 assert.equal(mcp.split('FilmLocalizationRepair.').length-1,1,'one entry only');
}
console.log('film-localization-repair: ok');
