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
const locRow=(file,id)=>rows(file,"SELECT status,source,value,authority FROM film_dimension WHERE dimension='localization' AND film_id="+q(id))[0]||null;
const receipts=file=>rows(file,"SELECT request_id,operation,origin,target_id,state,applied_revision FROM canonical_write_receipt ORDER BY request_id");
const world=file=>JSON.stringify([rows(file,"SELECT film_id,dimension,status,source,value,authority,updated_at FROM film_dimension ORDER BY film_id,dimension"),rows(file,"SELECT film_id,source,value FROM film_localization_source ORDER BY film_id,source"),rows(file,"SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id"),rows(file,"SELECT kind,source_key,payload_json,generation FROM owner_review_entry ORDER BY source_key"),receipts(file)]);
// Data only: the rows the operation may change, without receipts (a refused attempt may leave a non-applied receipt of the attempt itself).
const dataWorld=file=>JSON.stringify([rows(file,"SELECT film_id,dimension,status,source,value,authority,updated_at FROM film_dimension ORDER BY film_id,dimension"),rows(file,"SELECT film_id,source,value FROM film_localization_source ORDER BY film_id,source"),rows(file,"SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id"),rows(file,"SELECT kind,source_key,payload_json,generation FROM owner_review_entry ORDER BY source_key")]);
const appliedReceipts=file=>receipts(file).filter(row=>row.state==='applied').length;
const tool=(env,args)=>X.handleFilmLocalizationRepairTool(env,args,{now:clock});
const envOf=(file,bucket=new MemoryBucket())=>({DB:d1Standin(file),BUCKET:bucket});
const applyArgs=pre=>({mode:'apply',confirmGo:true,expectedFilmPersonGeneration:pre.expect.filmPersonGeneration,expectedOwnerReviewGeneration:pre.expect.ownerReviewGeneration,expectedCount:pre.expect.count,expectedDigest:pre.expect.digest});
const keys=bucket=>[...bucket.objects.keys()].sort();
const stateCount=(body,state)=>body.items.filter(item=>item.state===state).length;
// A D1 binding that COMMITS the first batch containing a localization write and then loses the reply.
const lossy=(file,bucket)=>{const db=d1Standin(file),real=db.batch.bind(db);let armed=true;db.batch=async statements=>{const result=await real(statements);if(armed&&statements.some(item=>/INSERT INTO film_dimension/.test(item.text))){armed=false;throw new Error('D1_ERROR: network connection lost');}return result;};return {DB:db,BUCKET:bucket};};

// ---- 0. The cohort is the AIR-683 evidence list, fixed, sorted and unique ----
{
 const evidence=fs.readFileSync('docs/evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md','utf8');
 const listed=[...evidence.match(/\*\*Observed stale Film ids[^\n]*\n\n([^\n]*)/)[1].matchAll(/`(film:[^`]+)`/g)].map(match=>match[1]);
 assert.equal(COHORT.length,16);
 assert.deepEqual([...COHORT],listed,'the code constant equals the ids recorded in the AIR-683 evidence');
 assert.deepEqual([...COHORT],[...COHORT].sort(),'code-unit order');
 assert.equal(new Set(COHORT).size,16);
 assert.throws(()=>{COHORT.push('film:x');},TypeError,'frozen');
}

// ---- 1. Argument gates: nothing is derived or written without the exact write arguments ----
{
 const file=database();seedCohort(file);const bucket=new MemoryBucket();const env=envOf(file,bucket);const before=world(file);
 for(const [args,reason] of [
  [null,'invalid'],[[],'invalid'],[{mode:'wave'},'invalid_mode'],[{mode:'apply'},'confirm_required'],[{mode:'apply',confirmGo:'yes'},'invalid_confirm'],
  [{mode:'apply',confirmGo:true},'invalid_expected_film_person_generation'],
  [{mode:'apply',confirmGo:true,expectedFilmPersonGeneration:2},'invalid_expected_owner_review_generation'],
  [{mode:'apply',confirmGo:true,expectedFilmPersonGeneration:2,expectedOwnerReviewGeneration:1,expectedCount:17,expectedDigest:'a'.repeat(64)},'invalid_expected_count'],
  [{mode:'apply',confirmGo:true,expectedFilmPersonGeneration:2,expectedOwnerReviewGeneration:1,expectedCount:3,expectedDigest:'xyz'},'invalid_expected_digest'],
  [{mode:'apply',confirmGo:true,expectedFilmPersonGeneration:2,expectedOwnerReviewGeneration:1,expectedCount:3,expectedDigest:'a'.repeat(64),filmId:COHORT[0]},'invalid_film_id_for_apply'],
  [{mode:'preflight',confirmGo:true},'invalid_arguments_for_read_only_mode'],[{mode:'recover',filmId:COHORT[0]},'invalid_arguments_for_read_only_mode'],[{mode:'preflight',expectedCount:1},'invalid_arguments_for_read_only_mode'],
  [{mode:'restore'},'confirm_required'],[{mode:'restore',confirmGo:true},'invalid_film_id'],[{mode:'restore',confirmGo:true,filmId:'film:tmdb:9999'},'invalid_film_id'],[{mode:'restore',confirmGo:true,filmId:COHORT[0],expectedCount:1},'invalid_arguments_for_restore'],
 ]){
  const result=await tool(env,args);
  assert.deepEqual([result.status,result.body.reason],[400,reason],JSON.stringify(args));
 }
 assert.equal(world(file),before);assert.equal(bucket.objects.size,0,'no argument error touches D1 or R2');
}

// ---- 2. Preflight: read only, per-Film states, reproducible digest, no payload, no write ----
const file=database();
seedCohort(file);
const OTHER='film:tmdb:9999';
seedFilm(file,OTHER,'9999');sourceRow(file,OTHER,'tmdb','Чужое',T1);
const bucket=new MemoryBucket();
const env=envOf(file,bucket);
let pre;
{
 const before=world(file);
 pre=(await tool(env,{})).body;
 const again=(await tool(env,{mode:'preflight'})).body;
 assert.deepEqual([pre.ok,pre.mode,pre.sideEffects,pre.decision,pre.cohort],[true,'preflight','none','eligible',16]);
 assert.deepEqual(pre.counts,{cohort:16,eligible:16,recorded:0,applied:0,restored:0,noop:0,held:0,absent:0,unavailable:0},'every cohort Film is eligible');
 assert.equal(pre.items.length,16);assert.deepEqual(pre.items.map(item=>item.id),[...COHORT]);
 assert.ok(pre.items.every(item=>item.state==='eligible'&&/^[0-9a-f]{64}$/.test(item.digest)&&item.plannedRevision===0&&/^localization_reconciler:film_localization_reconcile:[0-9a-f]{64}$/.test(item.requestId)));
 assert.deepEqual(pre.expect,{filmPersonGeneration:2,ownerReviewGeneration:1,count:16,digest:pre.expect.digest});
 assert.match(pre.expect.digest,/^[0-9a-f]{64}$/);
 assert.equal(again.expect.digest,pre.expect.digest,'fixed run id and write time: the digest is reproducible');
 assert.deepEqual(pre.pins,{filmPersonState:'open',filmPersonGeneration:2,schemaVersion:Number(one(file,'SELECT version FROM schema_contract WHERE id=1')),ownerReviewMode:'d1',ownerReviewWrites:pre.pins.ownerReviewWrites,ownerReviewGeneration:1});
 const text=JSON.stringify(pre);
 assert.ok(!text.includes('Значение')&&!text.includes('preImage')&&!text.includes('postImage')&&!text.includes(PREFIX),'no localization value, intent body or R2 key in the answer');
 assert.equal(world(file),before,'a preflight writes no D1 row and opens no receipt');assert.equal(bucket.objects.size,0,'a preflight writes no R2 object');
 const recover=(await tool(env,{mode:'recover'})).body;
 assert.deepEqual([recover.ok,recover.sideEffects,recover.items],[true,'none',[]]);
}

// ---- 3. A mismatch of any pin or digest writes nothing ----
{
 const before=world(file);
 for(const [patch,mismatched] of [[{expectedDigest:'0'.repeat(64)},['digest']],[{expectedCount:15},['count']],[{expectedFilmPersonGeneration:3},['filmPersonGeneration']],[{expectedOwnerReviewGeneration:2},['ownerReviewGeneration']]]){
  const result=await tool(env,{...applyArgs(pre),...patch});
  assert.deepEqual([result.status,result.body.reason,result.body.writes,result.body.mismatched],[409,'pins_mismatch',0,mismatched]);
 }
 assert.equal(world(file),before);assert.equal(bucket.objects.size,0,'a refused apply records nothing');
}

// ---- 4. A held Film (a reviewed row the resolver would not replace) blocks the whole apply: zero effects ----
{
 const f=database();seedCohort(f);
 // An owner row of one value and an owner decision of another: the planner holds it (`protected_row_differs`) and never rewrites it.
 exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ('film:xG0M','localization','reviewed','owner','verified',NULL,'Чужое','owner',0,'keep_reviewed','"+T+"')");
 exec(f,"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','tmdb_xg0m',"+q(JSON.stringify({localization:{status:'reviewed',value:'Жара',provenance:{authority:'owner'},updatedAt:T}}))+",'film:xG0M','verified',1)");
 const b=new MemoryBucket(),e=envOf(f,b),snap=world(f);
 const held=(await tool(e,{})).body;
 assert.deepEqual([held.decision,held.counts.held,held.counts.eligible,Object.keys(held.heldByReason).length],['blocked',1,15,1]);
 const refused=await tool(e,applyArgs({expect:{...held.expect,count:15}}));
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'not_eligible',0]);
 assert.equal(world(f),snap);assert.equal(b.objects.size,0);
 // A redirect is absent and also blocks.
 const g=database();seedCohort(g);exec(g,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:merged',1,'tmdb:777',NULL,'"+T+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:xG0M','film:merged','"+T+"')");
 const abs=(await tool(envOf(g),{})).body;
 assert.deepEqual([abs.decision,abs.counts.absent],['blocked',1]);
 // An authority that is not open is unsafe, and the owner domain not on D1 too.
 const h=database();seedCohort(h);exec(h,"UPDATE owner_review_authority SET mode='r2' WHERE id=1");
 const unsafe=(await tool(envOf(h),{})).body;
 assert.deepEqual([unsafe.decision,unsafe.failure,unsafe.expect],['unsafe','localization_owner_unavailable',null]);
 // No R2 binding: nothing can be proven recorded.
 const missing=await tool({DB:d1Standin(database())},{});
 assert.deepEqual([missing.status,missing.body.decision,missing.body.failure,missing.body.expect],[200,'unknown','checkpoint_unavailable',null]);
}

// ---- 5. Apply: record BEFORE the write, one receipted atomic batch per Film, settle after, scoped readback ----
let applied;
{
 const otherBefore=JSON.stringify([locRow(file,OTHER),revision(file,OTHER)]);
 const result=await tool(env,applyArgs(pre));
 applied=result.body;
 assert.equal(result.status,200);
 assert.deepEqual([applied.ok,applied.outcome,applied.writes,applied.applied,applied.stopped],[true,'complete',16,16,null]);
 assert.deepEqual(applied.counts,{applied:16,recovered:0,skipped:0,notAttempted:0,notApplied:0,unknown:0,failed:0});
 assert.deepEqual(applied.readback,{verified:16,unverified:0,staleAfter:0,rowIsPostImage:16,unreadable:false},'the receipt is applied at the post-revision, the row is the post-image and the resolver reports it current');
 for(const id of COHORT){
  assert.deepEqual(locRow(file,id),{status:'provisional',source:'tmdb',value:'Значение '+id,authority:null},id);
  assert.equal(revision(file,id),1,id+' one revision bump');
 }
 assert.equal(JSON.stringify([locRow(file,OTHER),revision(file,OTHER)]),otherBefore,'a Film outside the cohort is untouched');
 const done=receipts(file).filter(row=>row.operation==='film_localization_reconcile');
 assert.deepEqual([done.length,done.every(row=>row.state==='applied'&&row.origin==='localization_reconciler'&&row.applied_revision===1)],[16,true]);
 assert.deepEqual(keys(bucket).filter(key=>key.includes('/intents/')).length,16,'16 immutable intent objects');
 assert.equal(keys(bucket).filter(key=>key.includes('/events/')).length,16,'16 applied outcome events');
 assert.ok(keys(bucket).every(key=>key.startsWith(PREFIX)),'only the isolated prefix is written');
 const text=JSON.stringify(applied);
 assert.ok(!text.includes('Значение')&&!text.includes(PREFIX)&&!text.includes('postImage'),'no value, key or intent body in the answer');
 // Each recorded intent was durable before its write: the recorded post-revision proves the planned state.
 const sample=await (await bucket.get(keys(bucket).find(key=>key.includes('/intents/')))).json();
 assert.deepEqual([sample.plannedRevision,sample.postRevision,sample.runId,sample.at],[0,1,X.REPAIR_RUN_ID,X.REPAIR_AT]);
}

// ---- 6. Afterwards: nothing to do, idempotent, a repeated apply is refused with zero effects ----
{
 const after=(await tool(env,{})).body;
 assert.deepEqual([after.decision,after.counts.applied,after.counts.eligible,after.expect.count],['nothing_to_do',16,0,0]);
 const snap=world(file),objects=bucket.objects.size;
 const again=await tool(env,applyArgs(pre));
 assert.deepEqual([again.status,again.body.reason,again.body.writes],[409,'not_eligible',0]);
 assert.equal(world(file),snap);assert.equal(bucket.objects.size,objects);
 const recover=(await tool(env,{mode:'recover'})).body;
 assert.equal(recover.items.length,16);
 assert.ok(recover.items.every(item=>item.recordedState==='applied'&&item.classification.state==='applied'&&item.classification.rowIsPostImage===true));
}

// ---- 7. Restore: separately gated, exact recorded revision, once ----
{
 const id='film:1XYA';
 const result=await tool(env,{mode:'restore',confirmGo:true,filmId:id});
 assert.deepEqual([result.status,result.body.ok,result.body.state,result.body.writes,result.body.settleError],[200,true,'restored',1,null]);
 assert.equal(locRow(file,id),null,'a null pre-image deletes the row the operation created');
 assert.equal(revision(file,id),2,'a restore bumps the revision');
 const again=await tool(env,{mode:'restore',confirmGo:true,filmId:id});
 assert.deepEqual([again.status,again.body.reason,again.body.writes],[409,'no_applied_intent',0],'a restored intent cannot be restored twice');
 const view=(await tool(env,{})).body;
 assert.equal(view.items.find(item=>item.id===id).state,'restored');
 assert.ok(view.counts.eligible===0,'a restored Film is reported, never silently re-applied');
 // A concurrent legitimate change after the apply: restore refuses and erases nothing.
 const moved='film:27iE';
 exec(file,"UPDATE film_dimension SET value='Другое' WHERE film_id="+q(moved)+" AND dimension='localization';UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id="+q(moved));
 const snap=dataWorld(file),applies=appliedReceipts(file);
 const refused=await tool(env,{mode:'restore',confirmGo:true,filmId:moved});
 assert.deepEqual([refused.status,refused.body.reason,refused.body.writes],[409,'localization_restore_moved',0]);
 assert.equal(dataWorld(file),snap,'another writer is never erased');assert.equal(appliedReceipts(file),applies,'no applied receipt for a refused restore');
 const fresh=database();seedCohort(fresh);
 const unrecorded=await tool(envOf(fresh),{mode:'restore',confirmGo:true,filmId:'film:xG0M'});
 assert.deepEqual([unrecorded.status,unrecorded.body.reason,unrecorded.body.writes],[409,'no_applied_intent',0],'a Film with no recorded applied intent has nothing to restore');
}

// ---- 7b. A cohort Film that is already current is skipped, untouched, and not counted as work ----
{
 const f=database();
 const P=await load('film-localization-projection.js');
 for(const id of COHORT)if(id!=='film:xG0M')staleFilm(f,id);
 seedFilm(f,'film:xG0M',tmdbOf('film:xG0M'));
 const e=envOf(f);
 const sources=[{source:'tmdb',value:'Текущее',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(e,{id:'film:xG0M',expectedRevision:0,at:T,requestId:'req-current',sources,inputs:await P.readProjectionInputs(e,'film:xG0M',sources)});
 const current=JSON.stringify([locRow(f,'film:xG0M'),revision(f,'film:xG0M')]);
 const p=(await tool(e,{})).body;
 assert.deepEqual([p.decision,p.counts.eligible,p.counts.noop,p.expect.count],['eligible',15,1,15]);
 assert.equal(p.items.find(item=>item.id==='film:xG0M').state,'noop');
 const r=(await tool(e,applyArgs(p))).body;
 assert.deepEqual([r.ok,r.writes,r.counts.skipped,r.counts.applied],[true,15,1,15]);
 assert.equal(JSON.stringify([locRow(f,'film:xG0M'),revision(f,'film:xG0M')]),current,'the current Film is untouched');
 // If every cohort Film is already current the operation is a proved no-op.
 const allCurrent=database();
 for(const id of COHORT){seedFilm(allCurrent,id,tmdbOf(id));const ee=envOf(allCurrent);await P.writeFilmLocalizationProjection(ee,{id,expectedRevision:0,at:T,requestId:'req-'+id,sources,inputs:await P.readProjectionInputs(ee,id,sources)});}
 const none=(await tool(envOf(allCurrent),{})).body;
 assert.deepEqual([none.decision,none.counts.noop,none.expect.count],['nothing_to_do',16,0]);
}

// ---- 8. Checkpoint refusal: nothing is written for a Film whose intent is not durably recorded ----
{
 const f=database();seedCohort(f);
 const inner=new MemoryBucket();
 const failing={put:async()=>{throw new Error('R2 down');},get:async key=>inner.get(key),list:async o=>inner.list(o)};
 const e={DB:d1Standin(f),BUCKET:failing};
 const p=(await tool(e,{})).body,snap=world(f);
 const result=(await tool(e,applyArgs(p))).body;
 assert.deepEqual([result.ok,result.outcome,result.writes,result.stopped,result.counts.failed,result.counts.notAttempted],[false,'partial',0,'previous_film_failed',1,15]);
 assert.equal(result.items[0].reason,'localization_checkpoint_failed');
 assert.equal(world(f),snap,'a refused record writes nothing');
}

// ---- 9. The checkpoint: conditional create, full readback, idempotence, conflict, unreadable ----
{
 const f=database();seedCohort(f);
 const mk=bucket=>X.repairCheckpoint({BUCKET:bucket});
 const probe=(await tool(envOf(f),{})).body;void probe;
 const envx=envOf(f);const {readReconcileIntent}=await load('film-localization-reconciler.js');
 const {intent}=await readReconcileIntent(envx,COHORT[0],{runId:X.REPAIR_RUN_ID,at:X.REPAIR_AT});
 assert.ok(intent);
 const b=new MemoryBucket();let port=mk(b);
 await port.record(intent);await port.record(intent);
 assert.equal(b.objects.size,1,'the same intent twice is one object');
 // A timeout AFTER a successful put reads the object back and succeeds.
 const lateB=new MemoryBucket();const late=mk({put:async(...a)=>{await lateB.put(...a);throw new Error('timeout');},get:k=>lateB.get(k),list:o=>lateB.list(o)});
 await late.record(intent);assert.equal(lateB.objects.size,1);
 // A put that fails and leaves nothing is NOT recorded.
 const lost=mk({put:async()=>{throw new Error('timeout');},get:async()=>null,list:async()=>({objects:[],truncated:false})});
 await assert.rejects(()=>lost.record(intent),error=>error.code==='checkpoint_not_recorded');
 // A different object under the same key is a conflict.
 const key=[...b.objects.keys()][0];
 b.objects.set(key,{text:JSON.stringify({...JSON.parse(b.objects.get(key).text),at:'2026-11-29T00:00:00.000Z'}),customMetadata:{}});
 await assert.rejects(()=>port.record(intent),error=>error.code==='checkpoint_conflict');
 // An unreadable readback fails closed.
 const unreadable=mk({put:async()=>null,get:async()=>{throw new Error('R2 read');},list:async()=>({objects:[],truncated:false})});
 await assert.rejects(()=>unreadable.record(intent),error=>error.code==='checkpoint_unavailable');
 // Scope: an intent of another run or Film is refused before any object is created.
 const alien={...intent,runId:'other-run'};
 await assert.rejects(()=>mk(new MemoryBucket()).record(alien),error=>['film_person_invalid','checkpoint_scope'].includes(error.code));
 // Settlement: the event requires the recorded intent, is idempotent, obeys the transition table and keeps a single sequence.
 const s=new MemoryBucket();port=mk(s);
 await assert.rejects(()=>port.settle(intent,{state:'applied'}),error=>error.code==='checkpoint_not_recorded','no settlement without a recorded intent');
 await port.record(intent);
 await port.settle(intent,{state:'unknown',errorClass:'network'});
 await port.settle(intent,{state:'unknown',errorClass:'network'});
 assert.equal([...s.objects.keys()].filter(k=>k.includes('/events/')).length,1,'the same outcome twice is one event');
 await port.settle(intent,{state:'applied',revision:1,via:'recover'});
 await assert.rejects(()=>port.settle(intent,{state:'not_applied'}),error=>error.code==='checkpoint_transition_refused','an applied intent cannot become not_applied');
 await port.settle(intent,{state:'restored',revision:2,via:'restore'});
 await assert.rejects(()=>port.settle(intent,{state:'applied'}),error=>error.code==='checkpoint_transition_refused','restored is terminal');
 assert.deepEqual([...s.objects.keys()].filter(k=>k.includes('/events/')).map(k=>k.slice(-9)),['0001.json','0002.json','0003.json'],'one key per sequence');
 // A truncated listing cannot prove what is recorded.
 const trunc=mk({put:async()=>({}),get:async()=>null,list:async()=>({objects:[],truncated:true})});
 await assert.rejects(()=>trunc.settle(intent,{state:'applied'}),error=>['checkpoint_listing_truncated','checkpoint_not_recorded'].includes(error.code));
}

// ---- 10. A lost reply after the commit: recover classifies applied, the next apply settles it and continues ----
{
 const f=database();seedCohort(f);
 const b=new MemoryBucket();
 const pre1=(await tool(envOf(f,b),{})).body;
 const first=(await tool(lossy(f,b),applyArgs(pre1))).body;
 assert.deepEqual([first.ok,first.outcome,first.stopped,first.counts.unknown,first.counts.notAttempted],[false,'partial','unknown_outcome',1,15]);
 assert.equal(first.items[0].state,'unknown');
 assert.equal(revision(f,COHORT[0]),1,'the write DID commit before the reply was lost');
 const recover=(await tool(envOf(f,b),{mode:'recover'})).body;
 assert.deepEqual(recover.items.map(item=>[item.id,item.recordedState,item.classification.state]),[[COHORT[0],'unknown','applied']],'recovery is read only and classifies; it settles nothing');
 assert.equal([...b.objects.keys()].filter(k=>k.includes('/events/')).length,1,'recover wrote no event');
 const mid=(await tool(envOf(f,b),{})).body;
 assert.deepEqual([mid.decision,mid.counts.recorded,mid.counts.eligible,mid.expect.count],['eligible',1,15,16],'a recorded intent is never re-derived');
 const second=(await tool(envOf(f,b),applyArgs(mid))).body;
 assert.deepEqual([second.ok,second.outcome,second.counts.recovered,second.counts.applied,second.writes],[true,'complete',1,15,15]);
 assert.equal(second.items[0].state,'recovered_applied');
 for(const id of COHORT)assert.equal(revision(f,id),1,id+' written exactly once');
 assert.deepEqual([(await tool(envOf(f,b),{})).body.decision,receipts(f).filter(r=>r.operation==='film_localization_reconcile').length],['nothing_to_do',16]);
}

// ---- 11. An authority pin that moves between the preflight and the batch is asserted INSIDE the batch: nothing lands, recovery says not_applied ----
{
 const f=database();seedCohort(f);
 const b=new MemoryBucket();
 const pre1=(await tool(envOf(f,b),{})).body;
 const db=d1Standin(f),real=db.batch.bind(db);let moved=false;
 db.batch=async statements=>{if(!moved&&statements.some(item=>/INSERT INTO film_dimension/.test(item.text))){moved=true;exec(f,"UPDATE owner_review_authority SET generation=generation+1 WHERE id=1");}return real(statements);};
 const result=(await tool({DB:db,BUCKET:b},applyArgs(pre1))).body;
 assert.equal(result.ok,false);assert.equal(result.writes,0);
 assert.ok(result.stopped,'the run stops on the first refused Film');
 assert.equal(locRow(f,COHORT[0]),null,'the refused batch wrote nothing');assert.equal(revision(f,COHORT[0]),0);
 assert.deepEqual(result.items.slice(1).every(item=>item.state==='not_attempted'),true);
 // The pins moved: the old GO no longer matches, a fresh preflight is needed.
 const stale=await tool(envOf(f,b),applyArgs(pre1));
 assert.deepEqual([stale.status,stale.body.reason,stale.body.writes],[409,'pins_mismatch',0]);
 const fresh=(await tool(envOf(f,b),{})).body;
 assert.equal(fresh.expect.ownerReviewGeneration,2);
 const retry=(await tool(envOf(f,b),applyArgs(fresh))).body;
 assert.deepEqual([retry.ok,retry.writes],[true,16],'the same recorded intent resumes under the fresh pins and nothing is written twice');
 for(const id of COHORT)assert.equal(revision(f,id),1);
}

// ---- 12. A Film that moved after the intent was recorded is never overwritten; no blind retry ----
{
 const f=database();seedCohort(f);
 const b=new MemoryBucket();
 const pre1=(await tool(envOf(f,b),{})).body;
 const db=d1Standin(f),real=db.batch.bind(db);let bumped=false;
 db.batch=async statements=>{if(!bumped&&statements.some(item=>/INSERT INTO film_dimension/.test(item.text))){bumped=true;exec(f,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(COHORT[0])+",1,'"+T3+"')");}return real(statements);};
 const result=(await tool({DB:db,BUCKET:b},applyArgs(pre1))).body;
 assert.equal(result.ok,false);assert.equal(result.writes,0);
 assert.equal(locRow(f,COHORT[0]),null);
 assert.equal(result.items[0].state==='not_applied'||result.items[0].state==='unknown',true);
 assert.equal(stateCount(result,'not_attempted'),15,'nothing after the stopping Film is attempted');
}

// ---- 13. No migration, table, bucket or flag: the module touches only the existing isolated R2 prefix ----
{
 const source=fs.readFileSync('src/film-localization-repair.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\.delete\(|\.head\(/.test(source),'the operation never deletes an object');
 assert.ok(!/CREATE TABLE|ALTER TABLE|DROP /i.test(source));
 assert.ok(!chain.some(name=>fs.readFileSync('migrations/'+name,'utf8').includes('film-localization-repair')));
 assert.ok(!/WORKFLOW|QUEUE|scheduled\(|cron/i.test(source));
}
// ---- 14. The built Worker bundle reaches the operation through the one owner-only MCP tool (the build output exists after `npm run build`) ----
{
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(build.includes("scopedImports('src/film-localization-repair.js','FilmLocalizationRepair'"),'the build bundles the operation');
 const mcp=fs.readFileSync('src/mcp.js','utf8');
 assert.ok(mcp.includes('FilmLocalizationRepair.handleFilmLocalizationRepairTool(env,args)'),'the owner-only MCP tool calls the operation');
 assert.equal(mcp.split('FilmLocalizationRepair.').length-1,1,'one entry only');
}
console.log('film-localization-repair: ok');
