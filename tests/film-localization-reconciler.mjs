// AIR-663 / ADR 0218 stage 4 (decision 3): the separate, bounded Film localization reconciler (code only), on real SQLite (the sqlite3-CLI D1 stand-in). No Worker, R2 or Cloudflare access,
// no production invocation: the module is dormant and these fixtures are its only caller.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const load=name=>import(pathToFileURL(path.resolve('src',name)).href);
const R=process.env.FILM_RECONCILER_MODULE?await import(pathToFileURL(path.resolve(process.env.FILM_RECONCILER_MODULE)).href):await load('film-localization-reconciler.js');
const P=await load('film-localization-projection.js');
const {loadLocalizationInputs,resolveLocalization}=await load('localization-sources.js');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-reconciler-'));
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
function database({owner='d1'}={}){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 exec(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE);
 if(owner==='d1')exec(file,"UPDATE owner_review_authority SET mode='d1',generation=1 WHERE id=1");
 return file;
}
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const code=expected=>error=>{assert.equal(error.code,expected,error.stack);return true;};
const T='2026-11-25T10:00:00.000Z',T1='2026-11-25T11:00:00.000Z',T2='2026-11-25T12:00:00.000Z',T3='2026-11-25T13:00:00.000Z';
const FID='film:tmdb:1656',OTHER='film:tmdb:9999',PID='person:director/michael-mann';
const seedFilm=(file,id=FID,tmdb='1656')=>exec(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(id)+",1,"+q('tmdb:'+tmdb)+",NULL,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(id)+",'tmdb',"+q(tmdb)+",1,0,NULL);");
const revision=(file,id=FID)=>Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id="+q(id)+"),0)")??0);
const locRow=(file,id=FID)=>rows(file,"SELECT status,source,value,authority FROM film_dimension WHERE dimension='localization' AND film_id="+q(id))[0]||null;
const dimRow=(file,dim,id=FID)=>rows(file,"SELECT status,source,provenance_json,value,authority FROM film_dimension WHERE dimension="+q(dim)+" AND film_id="+q(id))[0]||null;
const sourceRows=(file,id=FID)=>rows(file,"SELECT source,value,observed_at FROM film_localization_source WHERE film_id="+q(id)+" ORDER BY source");
const ownerPayload=value=>JSON.stringify({localization:{status:'reviewed',value,provenance:{authority:'owner'},updatedAt:T}});
const addOwner=(file,{key='tmdb_1656',link=FID,value='Жара',generation=1}={})=>exec(file,"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film',"+q(key)+","+q(ownerPayload(value))+","+q(link)+",'verified',"+generation+")");
const ownerCommit=(file,{key='tmdb_1656',value})=>exec(file,"UPDATE owner_review_authority SET generation=generation+1 WHERE id=1;UPDATE owner_review_entry SET generation=(SELECT generation FROM owner_review_authority WHERE id=1);"+(value===null?"DELETE FROM owner_review_entry WHERE source_key="+q(key)+";":"UPDATE owner_review_entry SET payload_json="+q(ownerPayload(value))+" WHERE source_key="+q(key)+";"));
const src=(source,value,observedAt,extra={})=>({source,value,sourceVersion:'v1',provenance:null,observedAt,...extra});
const reviewedRow=(file,{value='Словарь',authority='dictionary',source='dictionary',id=FID}={})=>exec(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(id)+",'localization','reviewed',"+q(source)+",'verified',NULL,"+q(value)+","+q(authority)+",0,'keep_reviewed','"+T+"')");
const oldReader=async(env,id=FID)=>resolveLocalization((await loadLocalizationInputs(env,'film',[id])).get(id));

// ---- fixtures ----
const sourceRow=(file,id,source,value,observedAt,requestId='hist-1')=>exec(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ("+q(id)+","+q(source)+","+q(value)+",'v1','null',"+q(requestId)+","+q(observedAt)+","+q(observedAt)+")");
const receipts=file=>rows(file,"SELECT request_id,operation,origin,target_id,state,applied_revision,planned_revision FROM canonical_write_receipt ORDER BY request_id");
const snapshotRows=file=>JSON.stringify(rows(file,"SELECT film_id,dimension,status,source,value,authority,provenance_json,updated_at FROM film_dimension ORDER BY film_id,dimension"))+JSON.stringify(rows(file,"SELECT film_id,source,value,request_id FROM film_localization_source ORDER BY film_id,source"))+JSON.stringify(rows(file,"SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id"));
// A Film with source rows and NO effective row (a historical applied source receipt that predates the projection write, finding F5).
const staleFilm=(file,id,tmdb,value='Схватка TMDB')=>{seedFilm(file,id,tmdb);sourceRow(file,id,'tmdb',value,T1);};
const clock=()=>T3;
// An advancing clock: every reading is later than the previous one (a real clock), so a plan, a write and a restore never share a reading.
const ticking=()=>{let t=Date.parse(T3);return ()=>new Date(t+=1000).toISOString();};
// The durable checkpoint port the production operation supplies; here an in-memory one that records every call.
const memory=({failRecord=false,failSettle=false}={})=>{const log={records:[],settles:[]};return {log,record:async intent=>{if(failRecord)throw new Error('disk full');log.records.push(intent);},settle:async(intent,result)=>{if(failSettle)throw new Error('disk full');log.settles.push({requestId:intent.requestId,...result});}};};
const apply=(env,options)=>R.applyLocalizationReconcile(env,{checkpoint:memory(),now:clock,...options});
const ownerEntryWithoutTime=(file,{key='tmdb_1656',link=FID,value='Жара'}={})=>exec(file,"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film',"+q(key)+","+q(JSON.stringify({localization:{status:'reviewed',value,provenance:{authority:'owner'}}}))+","+q(link)+",'verified',1)");
// A D1 binding that COMMITS the batch containing a localization write and then loses the reply (the Worker never learns the outcome).
const lossy=file=>{const db=d1Standin(file),real=db.batch.bind(db);let armed=true;db.batch=async statements=>{const result=await real(statements);if(armed&&statements.some(item=>/INSERT INTO film_dimension/.test(item.text))){armed=false;throw new Error('D1_ERROR: network connection lost');}return result;};return {DB:db};};

// ---- 1. Dry run is read only and finds the stale projection (a historical receipt, no new source) ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const before=snapshotRows(file);
 const report=await R.dryRunLocalizationReconcile(env,{now:clock});
 assert.deepEqual([report.examined,report.stale.length,report.held.length,report.noop,report.wouldWrite,report.hasMore],[1,1,0,0,1,false]);
 assert.deepEqual([report.stale[0].id,report.stale[0].preImage,report.stale[0].postImage.value,report.stale[0].effective],[FID,null,'Схватка TMDB',{value:'Схватка TMDB',tier:'automatic',source:'tmdb'}]);
 assert.equal(snapshotRows(file),before,'a dry run writes no row and bumps no revision');
 assert.deepEqual(receipts(file),[],'a dry run opens no receipt');
}

// ---- 2. Apply: the checkpoint is REQUIRED and recorded BEFORE the write; the intent is the pre-image token; own receipt; settled after ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 await assert.rejects(()=>R.applyLocalizationReconcile(env,{runId:'run-0',now:clock}),code('film_person_invalid'),'an apply without a checkpoint port fails closed before anything is read for writing');
 await assert.rejects(()=>R.applyLocalizationReconcile(env,{runId:'run-0',now:clock,checkpoint:{record:async()=>{}}}),code('film_person_invalid'));
 assert.deepEqual([receipts(file),revision(file)],[[],0]);
 const port=memory();
 const order=[];const spy={record:async intent=>{order.push(['record',revision(file)]);await port.record(intent);},settle:async(intent,result)=>{order.push(['settle',revision(file)]);await port.settle(intent,result);}};
 const run=await R.applyLocalizationReconcile(env,{runId:'run-1',checkpoint:spy,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.moved.length,run.held.length,run.stopped,run.cursor],[1,0,0,0,null,FID]);
 assert.deepEqual(order,[['record',0],['settle',1]],'the intent is durable before the revision moves and settled after');
 const token=run.written[0];
 assert.deepEqual([token.id,token.preImage,token.postImage.value,token.postImage.status,token.plannedRevision,token.postRevision],[FID,null,'Схватка TMDB','provisional',0,1]);
 assert.deepEqual([port.log.records.length,port.log.records[0].requestId],[1,token.requestId],'the recorded intent is the returned token');
 assert.deepEqual(locRow(file),{status:'provisional',source:'tmdb',value:'Схватка TMDB',authority:null});
 assert.equal(revision(file),1,'one revision bump');
 const stored=receipts(file);
 assert.deepEqual(stored.map(r=>[r.operation,r.origin,r.target_id,r.state,r.applied_revision,r.planned_revision]),[['film_localization_reconcile','localization_reconciler',FID,'applied',1,0]]);
 assert.equal(stored[0].request_id,token.requestId);
 assert.deepEqual(sourceRows(file),[{source:'tmdb',value:'Схватка TMDB',observed_at:T1}],'no source row is written or changed');
 assert.deepEqual((await oldReader(env)).value,'Схватка TMDB');
 const again=await apply(env,{runId:'run-1'});
 assert.deepEqual([again.written.length,again.noop,receipts(file).length,revision(file)],[0,1,1,1],'a repeat finds nothing to write');
}

// ---- 3. Owner-only change: a stale marked owner projection after the decision is removed, no new observation ----
{
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 const s=[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(env,{id:FID,expectedRevision:revision(file),at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env,FID,s)});
 assert.equal(locRow(file).authority,'owner');
 assert.equal((await R.dryRunLocalizationReconcile(env,{now:clock})).noop,1,'nothing is stale while the decision stands');
 ownerCommit(file,{value:null});
 const stale=await R.dryRunLocalizationReconcile(env,{now:clock});
 assert.deepEqual([stale.stale.length,stale.stale[0].effective],[1,{value:'Схватка',tier:'automatic',source:'tmdb'}]);
 const rev=revision(file);
 const run=await apply(env,{runId:'run-2'});
 assert.deepEqual([run.written.length,locRow(file),revision(file)],[1,{status:'provisional',source:'tmdb',value:'Схватка',authority:null},rev+1]);
 assert.equal(run.written[0].preImage.authority,'owner','the pre-image is the owner projection row');
 // owner CHANGE (value)
 const file2=database();seedFilm(file2);addOwner(file2);
 const env2={DB:d1Standin(file2)};
 await P.writeFilmLocalizationProjection(env2,{id:FID,expectedRevision:0,at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env2,FID,s)});
 ownerCommit(file2,{value:'Жара 2'});
 const run2=await apply(env2,{runId:'run-3'});
 assert.deepEqual([run2.written.length,locRow(file2).value,locRow(file2).authority],[1,'Жара 2','owner']);
 // an owner-only value with no row at all is materialized as the owner projection
 const file3=database();seedFilm(file3);addOwner(file3);
 const run3=await apply({DB:d1Standin(file3)},{runId:'run-4'});
 assert.deepEqual([run3.written.length,dimRow(file3,'localization').authority,JSON.parse(dimRow(file3,'localization').provenance_json).projection],[1,'owner','owner_review']);
}

// ---- 4. Held cases write nothing and manufacture no decision ----
{
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 const s=[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(env,{id:FID,expectedRevision:0,at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env,FID,s)});
 exec(file,"DELETE FROM film_localization_source");
 ownerCommit(file,{value:null});
 const before=snapshotRows(file),port=memory();
 const run=await R.applyLocalizationReconcile(env,{runId:'run-h1',checkpoint:port,now:clock});
 assert.deepEqual([run.written.length,run.held,receipts(file).length,snapshotRows(file)===before,port.log.records.length],[0,[{id:FID,reason:'owner_projection_without_input'}],0,true,0],'a hold records no intent and opens no receipt');
 const file2=database();seedFilm(file2);reviewedRow(file2,{value:'Чужое',authority:'owner',source:'owner'});addOwner(file2);
 const run2=await apply({DB:d1Standin(file2)},{runId:'run-h2'});
 assert.deepEqual([run2.written.length,run2.held[0].reason,locRow(file2).value],[0,'protected_row_differs','Чужое']);
 const file3=database();staleFilm(file3,FID,'1656');reviewedRow(file3,{value:'Жара',authority:'owner',source:'owner'});
 const run3=await apply({DB:d1Standin(file3)},{runId:'run-h3'});
 assert.deepEqual([run3.written.length,run3.noop,locRow(file3).value],[0,1,'Жара']);
 const file4=database();seedFilm(file4);addOwner(file4,{key:'a',value:'А'});addOwner(file4,{key:'b',value:'Б'});
 const run4=await apply({DB:d1Standin(file4)},{runId:'run-h4'});
 assert.deepEqual([run4.written.length,run4.held[0].reason],[0,'owner_conflict']);
}

// ---- 5. Legacy provisional candidate is preserved losslessly as a source row, never lost ----
{
 const file=database();seedFilm(file);
 exec(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','letterboxd','v1',NULL,'Старое',NULL,0,'none','"+T+"')");
 sourceRow(file,FID,'tmdb','Схватка TMDB',T1);
 const run=await apply({DB:d1Standin(file)},{runId:'run-l1'});
 assert.deepEqual([run.written.length,run.noop,locRow(file).value],[0,1,'Старое'],'letterboxd ranks above tmdb: already the resolver output, a no-op that loses nothing');
 const file2=database();seedFilm(file2);
 exec(file2,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','epg','v1',NULL,'Эпг',NULL,0,'none','"+T+"')");
 sourceRow(file2,FID,'tmdb','Схватка TMDB',T1);
 const run2=await apply({DB:d1Standin(file2)},{runId:'run-l2'});
 assert.equal(run2.written.length,1);
 assert.deepEqual([locRow(file2).value,sourceRows(file2).map(r=>r.source)],['Схватка TMDB',['epg','tmdb']],'the legacy candidate is now a durable source row');
}

// ---- 6. Bounds: a keyset page of RAW Film ids (scan bounded by the limit whatever the candidates), write cap, cursor, invalid caps ----
{
 const file=database();
 for(const [i,id] of ['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:tmdb:4'].entries())staleFilm(file,id,String(i+1),'Т'+i);
 const env={DB:d1Standin(file)};
 const dry=await R.dryRunLocalizationReconcile(env,{limit:3,writeCap:2,now:clock});
 assert.deepEqual([dry.examined,dry.stale.length,dry.wouldWrite,dry.hasMore,dry.cursor],[3,3,2,true,'film:tmdb:3']);
 const one1=await apply(env,{runId:'run-c1',limit:4,writeCap:2});
 assert.deepEqual([one1.written.length,one1.stopped,one1.hasMore,one1.cursor],[2,'write_cap',true,'film:tmdb:2'],'the run stops writing at the cap and names where to continue');
 const two=await apply(env,{runId:'run-c2',after:one1.cursor,limit:4,writeCap:2});
 assert.deepEqual([two.written.length,two.stopped,two.hasMore],[2,null,false],'the last page reports no continuation');
 for(const bad of [0,-1,1.5,51,'3'])await assert.rejects(()=>R.dryRunLocalizationReconcile(env,{limit:bad}),code('film_person_invalid'));
 await assert.rejects(()=>apply(env,{runId:'r',writeCap:26}),code('film_person_invalid'));
 await assert.rejects(()=>apply(env,{runId:''}),code('film_person_invalid'));
 await assert.rejects(()=>R.dryRunLocalizationReconcile(env,{after:'person:x'}),code('film_person_invalid'));
 // sparse: Films that are not candidates still count against the examined bound (no hidden scan)
 const file2=database();
 for(const id of ['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:tmdb:4'])seedFilm(file2,id,id.split(':')[2]);
 const env2={DB:d1Standin(file2)};
 const sparse=await R.dryRunLocalizationReconcile(env2,{limit:2,now:clock});
 assert.deepEqual([sparse.examined,sparse.noop,sparse.stale.length,sparse.hasMore,sparse.cursor],[2,2,0,true,'film:tmdb:2'],'two raw Films examined, continuation reported');
 const last=await R.dryRunLocalizationReconcile(env2,{limit:2,after:sparse.cursor,now:clock});
 assert.deepEqual([last.examined,last.hasMore,last.cursor],[2,false,'film:tmdb:4']);
 const empty=await R.dryRunLocalizationReconcile(env2,{limit:2,after:'film:tmdb:4',now:clock});
 assert.deepEqual([empty.examined,empty.hasMore,empty.cursor],[0,false,'film:tmdb:4']);
}

// ---- 7. Owner value reachable only through a merged ancestor is found; a redirected Film is never writable ----
{
 const file=database();seedFilm(file);seedFilm(file,OTHER,'9999');
 exec(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(OTHER)+","+q(FID)+",'"+T+"')");
 addOwner(file,{key:'old',link:OTHER,value:'Жара предка'});
 const env={DB:d1Standin(file)};
 const dry=await R.dryRunLocalizationReconcile(env,{now:clock});
 assert.deepEqual([dry.examined,dry.absent,dry.stale.map(item=>item.id),dry.stale[0].postImage.value],[2,1,[FID],'Жара предка'],'the survivor with an ancestor-only owner entry is a candidate; the redirected Film is not');
 const run=await apply(env,{runId:'run-a1'});
 assert.deepEqual([run.written.map(item=>item.id),run.absent,locRow(file).authority,locRow(file,OTHER)],[[FID],1,'owner',null]);
}

// ---- 8. Concurrent mutation against the INTENT: moved resolver input, moved owner decision, moved revision, changed non-resolver column; nothing is written ----
{
 const file=database();staleFilm(file,FID,'1656');addOwner(file);
 const env={DB:d1Standin(file)};
 const {intent}=await R.readReconcileIntent(env,FID,{runId:'w',at:T3});
 const before=snapshotRows(file);
 sourceRow(file,FID,'letterboxd','Новое',T2,'other');
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env,{intent}),code('localization_inputs_moved'));
 const second=(await R.readReconcileIntent(env,FID,{runId:'w',at:T3})).intent;
 ownerCommit(file,{value:'Жара 2'});
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env,{intent:second}),code('localization_inputs_moved'));
 const third=(await R.readReconcileIntent(env,FID,{runId:'w',at:T3})).intent;
 exec(file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(FID)+",1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1");
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env,{intent:third}),code('film_person_revision_conflict'));
 assert.equal(locRow(file),null,'every refusal wrote nothing');
 // a changed NON-resolver column of the stored row (same revision): the intent's full pre-image no longer matches
 const file2=database();seedFilm(file2);
 exec(file2,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','epg','v1',NULL,'Эпг',NULL,0,'none','"+T+"')");
 sourceRow(file2,FID,'tmdb','Схватка TMDB',T1);
 const env2={DB:d1Standin(file2)};
 const {intent: pinned}=await R.readReconcileIntent(env2,FID,{runId:'w2',at:T3});
 exec(file2,"UPDATE film_dimension SET attempts=7,last_error='x' WHERE film_id="+q(FID)+" AND dimension='localization'");
 const kept=snapshotRows(file2);
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env2,{intent:pinned}),code('localization_inputs_moved'));
 assert.equal(snapshotRows(file2),kept);
 // inside a pass a definite replan refusal is `moved`: the pass goes on, the intent is settled as not applied, the Film is retried under a NEW intent next run
 const file3=database();staleFilm(file3,'film:tmdb:1','1');staleFilm(file3,'film:tmdb:2','2');
 let fired=false;
 const db3=d1Standin(file3,{onBatch:async statements=>{if(!fired&&statements.some(item=>/INSERT INTO film_dimension/.test(item.text)&&/film:tmdb:1/.test(item.text))){fired=true;exec(file3,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:tmdb:1',1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1");}}});
 const p3=memory();
 const pass=await R.applyLocalizationReconcile({DB:db3},{runId:'mv',checkpoint:p3,now:clock});
 assert.deepEqual([pass.moved,pass.written.map(x=>x.id),pass.stopped,p3.log.settles.map(x=>x.state)],[[{id:'film:tmdb:1',code:'film_person_revision_conflict'}],['film:tmdb:2'],null,['not_applied','applied']]);
 assert.equal(locRow(file3,'film:tmdb:1'),null);
 const next=await apply({DB:d1Standin(file3)},{runId:'mv2'});
 assert.deepEqual([next.written.map(x=>x.id),next.written[0].plannedRevision],[['film:tmdb:1'],1],'the next run plans a new intent at the moved revision');
}

// ---- 9. P1-1: the pre-image survives a lost reply, a refused checkpoint and a failure on the NEXT Film ----
{
 // commit, then the reply is lost: the pass returns (never throws), lists the intent as uncertain and the recorded intent recovers
 const file=database();staleFilm(file,FID,'1656');
 const port=memory();
 const run=await R.applyLocalizationReconcile(lossy(file),{runId:'lost',checkpoint:port,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.stopped!==null,run.failedId,run.cursor],[0,1,true,FID,''],'progress is returned on a failed exit; the resume point is before the failed Film');
 assert.equal(port.log.records.length,1,'the intent was durable before the write');
 assert.deepEqual(port.log.settles.map(x=>x.state),['unknown'],'the unknown outcome is settled as unknown, never guessed');
 assert.equal(revision(file),1,'the commit really happened');
 const recovered=await R.recoverLocalizationReconcile({DB:d1Standin(file)},{intent:port.log.records[0]});
 assert.deepEqual([recovered.state,recovered.rowIsPostImage],['applied',true],'recovered from the recorded intent against the applied receipt and the revision');
 assert.deepEqual(run.uncertain[0],port.log.records[0]);
 const before=snapshotRows(file);
 const resumed=await R.resumeLocalizationReconcile({DB:d1Standin(file)},{intent:port.log.records[0],now:clock});
 assert.deepEqual([resumed.state,snapshotRows(file)===before],['applied',true],'a resume of an applied intent never double-writes');
 // the token (the recorded intent) restores the row even though the reply was lost
 const back=await R.restoreLocalizationReconcile({DB:d1Standin(file)},{runId:'undo',token:port.log.records[0],now:clock});
 assert.deepEqual([back.state,locRow(file)],['applied',null]);
 // a repeat of the pass over the same state: nothing left, nothing to double-write
 const file1=database();staleFilm(file1,FID,'1656');
 const p1=memory();
 await R.applyLocalizationReconcile(lossy(file1),{runId:'lost2',checkpoint:p1,now:clock});
 const noMore=await apply({DB:d1Standin(file1)},{runId:'lost3'});
 assert.deepEqual([noMore.written.length,noMore.noop,revision(file1)],[0,1,1]);

 // the checkpoint cannot be recorded: nothing is written for that Film
 const file2=database();staleFilm(file2,FID,'1656');
 const refused=await R.applyLocalizationReconcile({DB:d1Standin(file2)},{runId:'cp',checkpoint:memory({failRecord:true}),now:clock});
 assert.deepEqual([refused.written.length,refused.stopped,refused.failedId,refused.cursor,receipts(file2).length,revision(file2),locRow(file2)],[0,R.CHECKPOINT_FAILED,FID,'',0,0,null],'fail closed before the commit');

 // a not-yet-written recorded intent: recovery says not_applied and a resume writes it exactly once
 const file3=database();staleFilm(file3,FID,'1656');
 const env3={DB:d1Standin(file3)};
 const {intent}=await R.readReconcileIntent(env3,FID,{runId:'pre',at:T3});
 assert.equal((await R.recoverLocalizationReconcile(env3,{intent})).state,'not_applied');
 const done=await R.resumeLocalizationReconcile(env3,{intent,now:clock});
 assert.deepEqual([done.state,revision(file3),locRow(file3).value],['applied',1,'Схватка TMDB']);
 const twice=await R.resumeLocalizationReconcile(env3,{intent,now:clock});
 assert.deepEqual([twice.state,revision(file3),receipts(file3).length],['applied',1,1],'the same intent is never written twice');
 assert.equal((await R.recoverLocalizationReconcile(env3,{intent})).state,'applied');

 // the NEXT Film fails to read after the first committed: the first pre-image is not lost
 const file4=database();staleFilm(file4,'film:tmdb:1','1');staleFilm(file4,'film:tmdb:2','2');
 const db4=d1Standin(file4,{onQuery:async text=>{if(/FROM film WHERE id='film:tmdb:2'/.test(text))throw new Error('D1_ERROR: boom');}});
 const p4=memory();
 const part=await R.applyLocalizationReconcile({DB:db4},{runId:'part',checkpoint:p4,now:clock});
 assert.deepEqual([part.written.map(x=>x.id),part.cursor,part.failedId,part.error.code,part.uncertain.length],[['film:tmdb:1'],'film:tmdb:1','film:tmdb:2','film_person_unavailable',0],'the committed Film keeps its intent and the failed Film is the resume point');
 assert.deepEqual(p4.log.settles.map(x=>x.state),['applied']);
 // a settle that fails after the commit still returns the written intent
 const file5=database();staleFilm(file5,FID,'1656');
 const bad=await R.applyLocalizationReconcile({DB:d1Standin(file5)},{runId:'settle',checkpoint:memory({failSettle:true}),now:clock});
 assert.deepEqual([bad.written.length,bad.stopped],[1,'localization_checkpoint_settle_failed']);
}

// ---- 10. P1-2: the stable write time and the full images are bound; a real advancing clock and an owner value with no timestamp restore exactly ----
{
 const file=database();seedFilm(file);ownerEntryWithoutTime(file);
 const env={DB:d1Standin(file)};
 const run=await R.applyLocalizationReconcile(env,{runId:'tick',checkpoint:memory(),now:ticking()});
 assert.equal(run.written.length,1);
 const token=run.written[0];
 const stored=rows(file,"SELECT updated_at FROM film_dimension WHERE film_id="+q(FID)+" AND dimension='localization'")[0].updated_at;
 assert.equal(stored,token.postImage.updated_at,'the committed row equals the receipt-bound image: the clock of the plan, not of the write');
 assert.equal(token.postImage.updated_at,token.at);
 const back=await R.restoreLocalizationReconcile(env,{runId:'tick-undo',token,now:ticking()});
 assert.deepEqual([back.state,locRow(file)],['applied',null],'the exact-image restore succeeds with no intervening writer');
 // the digest binds the images, the time and the planned revision
 const d1=await R.reconcileDigest({id:FID,inputs:{},preImage:null,postImage:token.postImage,at:token.at,plannedRevision:0});
 for(const change of [{at:T1},{plannedRevision:1},{preImage:token.postImage},{postImage:{...token.postImage,attempts:3}}])assert.notEqual(await R.reconcileDigest({id:FID,inputs:{},preImage:null,postImage:token.postImage,at:token.at,plannedRevision:0,...change}),d1);
}

// ---- 11. P1-3: a restore token is validated and bound to its own applied receipt before any receipt is reserved ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const run=await apply(env,{runId:'rs1'});
 const token=run.written[0];
 const kept=()=>[snapshotRows(file),receipts(file).length];
 const before=kept();
 const refuse=async(bad,expected,label)=>{await assert.rejects(()=>R.restoreLocalizationReconcile(env,{runId:'rs-x',token:bad,now:clock}),code(expected),label);assert.deepEqual(kept(),before,label+': no domain row, revision or receipt changed');};
 const noPre={...token};delete noPre.preImage;
 await refuse(noPre,'film_person_invalid','a missing preImage is never read as "delete the row"');
 await refuse({...token,preImage:{status:'provisional'}},'film_person_invalid','an incomplete pre-image');
 await refuse({...token,postImage:null},'film_person_invalid','a missing post-image');
 await refuse({...token,postImage:{...token.postImage,extra:1}},'film_person_invalid','a malformed image');
 await refuse({...token,preImage:{...token.postImage,value:'Подделка'}},'film_person_invalid','a fabricated pre-image does not match the digest');
 await refuse({...token,requestId:token.requestId+'x'},'film_person_invalid','another request identity');
 await refuse({...token,digest:'0'.repeat(64)},'film_person_invalid','another digest');
 await refuse({...token,postRevision:5},'film_person_invalid','another revision');
 await refuse({...token,id:OTHER},'film_person_invalid','another target');
 await refuse(null,'film_person_invalid','no token');
 // a well-formed intent that no applied reconcile receipt backs (never applied, or another run): unbound
 const file2=database();staleFilm(file2,FID,'1656');
 const env2={DB:d1Standin(file2)};
 const {intent}=await R.readReconcileIntent(env2,FID,{runId:'ghost',at:T3});
 const b2=[snapshotRows(file2),receipts(file2).length];
 await assert.rejects(()=>R.restoreLocalizationReconcile(env2,{runId:'rs-y',token:intent,now:clock}),code(R.RESTORE_UNBOUND),'an intent with no applied receipt');
 assert.deepEqual([snapshotRows(file2),receipts(file2).length],b2);
 // owner evidence unavailable: the restore gate refuses before any receipt
 const file3=database();staleFilm(file3,FID,'1656');
 const env3={DB:d1Standin(file3)};
 const run3=await apply(env3,{runId:'rs3'});
 exec(file3,"UPDATE owner_review_authority SET mode='r2' WHERE id=1");
 const b3=[snapshotRows(file3),receipts(file3).length];
 await assert.rejects(()=>R.restoreLocalizationReconcile(env3,{runId:'rs-z',token:run3.written[0],now:clock}),code('localization_owner_unavailable'));
 assert.deepEqual([snapshotRows(file3),receipts(file3).length],b3);
 // the valid token still restores; a second restore and a moved Film are refused
 const ok=await R.restoreLocalizationReconcile(env,{runId:'rs-ok',token,now:clock});
 assert.deepEqual([ok.state,locRow(file),revision(file)],['applied',null,2]);
 await assert.rejects(()=>R.restoreLocalizationReconcile(env,{runId:'rs-again',token,now:clock}),code(R.RESTORE_MOVED));
 const file4=database();staleFilm(file4,FID,'1656');
 const env4={DB:d1Standin(file4)};
 const run4=await apply(env4,{runId:'rs4'});
 exec(file4,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id="+q(FID));
 const b4=snapshotRows(file4);
 await assert.rejects(()=>R.restoreLocalizationReconcile(env4,{runId:'rs-m',token:run4.written[0],now:clock}),code(R.RESTORE_MOVED));
 assert.equal(snapshotRows(file4),b4,'a refused restore writes nothing');
 const file5=database();staleFilm(file5,FID,'1656');
 const env5={DB:d1Standin(file5)};
 const run5=await apply(env5,{runId:'rs5'});
 exec(file5,"UPDATE film_dimension SET value='Иное' WHERE film_id="+q(FID)+" AND dimension='localization'");
 await assert.rejects(()=>R.restoreLocalizationReconcile(env5,{runId:'rs-e',token:run5.written[0],now:clock}),code(R.RESTORE_MOVED));
 assert.equal(locRow(file5).value,'Иное');
 // restore of an overwritten row to its exact previous image (the marked owner projection)
 const file6=database();seedFilm(file6);addOwner(file6);
 const env6={DB:d1Standin(file6)};
 const s=[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(env6,{id:FID,expectedRevision:0,at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env6,FID,s)});
 ownerCommit(file6,{value:null});
 const run6=await apply(env6,{runId:'rs6'});
 const back=await R.restoreLocalizationReconcile(env6,{runId:'rs-6',token:run6.written[0],now:clock});
 assert.deepEqual([back.state,locRow(file6).authority,locRow(file6).value],['applied','owner','Жара']);
 // forward correction: after a moved row the same reconciler corrects it afterwards under a new receipt and a new intent
 const fwd=await apply(env5,{runId:'rs7'});
 assert.deepEqual([fwd.written.length,locRow(file5).value],[1,'Схватка TMDB']);
}

// ---- 12. Gates: marker not open, owner domain not D1, a redirect ----
{
 const file=database();staleFilm(file,FID,'1656');
 exec(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 const port=memory();
 await assert.rejects(()=>R.applyLocalizationReconcile({DB:d1Standin(file)},{runId:'g1',checkpoint:port,now:clock}),error=>typeof error.code==='string'&&error.code.startsWith('film_person'));
 assert.deepEqual([locRow(file),port.log.records.length],[null,0]);
 const file2=database({owner:'r2'});staleFilm(file2,FID,'1656');
 const env2={DB:d1Standin(file2)};
 const dry=await R.dryRunLocalizationReconcile(env2,{now:clock});
 assert.deepEqual([dry.stale.length,dry.unavailable],[0,[{id:FID,code:'localization_owner_unavailable'}]],'owner evidence that cannot be proven is never read as a decision');
 const run=await apply(env2,{runId:'g2'});
 assert.deepEqual([run.written.length,run.stopped,run.failedId,locRow(file2)],[0,'localization_owner_unavailable',FID,null],'an unavailable owner domain stops the pass with its progress returned');
}

// ---- 13. Delivery runs nothing: no importer outside the tests, no side effect on import, no route, flag, Task, schema or Worker entry ----
{
 const importers=[];
 for(const dir of ['src','scripts','public','.github']){
  const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name==='node_modules'?[]:walk(path.join(d,e.name))):[path.join(d,e.name)]):[];
  for(const file of walk(dir))if(!file.endsWith('src/film-localization-reconciler.js')&&/\.(js|mjs|yml|yaml|json|html)$/.test(file)&&fs.readFileSync(file,'utf8').includes('film-localization-reconciler.js'))importers.push(file);
 }
 assert.deepEqual(importers,[],'no Worker, route, MCP tool, Workflow, cron, script or workflow imports the reconciler');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('film-localization-reconciler.js'),'the build does not bundle it');
 const spec=R.filmLocalizationReconcileOperation();
 assert.equal(spec.atomic,true);
 const {OPERATION_KINDS}=await load('canonical-receipts.js');
 assert.ok(OPERATION_KINDS.includes(R.RECONCILE_OPERATION));
 assert.ok(!chain.some(name=>fs.readFileSync('migrations/'+name,'utf8').includes('film_localization_reconcile')),'no migration, table, index or column belongs to the reconciler');
}

// ---- 14. Registry spec: a payload-free receipt can neither be re-planned nor replayed; it is abandoned, and only the recorded intent settles it ----
{
 const spec=R.filmLocalizationReconcileOperation();
 assert.deepEqual(await spec.readback({}, {kind:'film',id:FID},{}),{disposition:'abandon',errorClass:R.RECONCILE_INTENT_REQUIRED});
 assert.equal(await spec.revalidate({},{}),'stale');
 await assert.rejects(()=>spec.replay({},{},{}),code('producer_replan_unavailable'));
 // an unsettled receipt of the kind whose row already equals the output is never applied from content alone
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const {intent}=await R.readReconcileIntent(env,FID,{runId:'u',at:T3});
 await R.resumeLocalizationReconcile(env,{intent,now:clock});
 const other={...intent,runId:'v'};
 await assert.rejects(()=>R.resumeLocalizationReconcile(env,{intent:other,now:clock}),code('film_person_invalid'),'an intent whose request id does not recompute is refused');
}
console.log('film-localization-reconciler: ok');
