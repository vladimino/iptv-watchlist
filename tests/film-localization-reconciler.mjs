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
const snapshotRows=file=>JSON.stringify(rows(file,"SELECT film_id,dimension,status,source,value,authority,provenance_json,updated_at FROM film_dimension ORDER BY film_id,dimension")+JSON.stringify(rows(file,"SELECT film_id,source,value,request_id FROM film_localization_source ORDER BY film_id,source")));
// A Film with source rows and NO effective row (a historical applied source receipt that predates the projection write, finding F5).
const staleFilm=(file,id,tmdb,value='Схватка TMDB')=>{seedFilm(file,id,tmdb);sourceRow(file,id,'tmdb',value,T1);};
const clock=()=>T3;

// ---- 1. Dry run is read only and finds the stale projection (a historical receipt, no new source) ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const before=snapshotRows(file),rev=revision(file);
 const report=await R.dryRunLocalizationReconcile(env,{now:clock});
 assert.deepEqual([report.examined,report.stale.length,report.held.length,report.noop,report.wouldWrite,report.hasMore],[1,1,0,0,1,false]);
 assert.deepEqual([report.stale[0].id,report.stale[0].preImage,report.stale[0].postImage.value,report.stale[0].effective],[FID,null,'Схватка TMDB',{value:'Схватка TMDB',tier:'automatic',source:'tmdb'}]);
 assert.equal(snapshotRows(file),before,'a dry run writes no row');
 assert.equal(revision(file),rev,'a dry run bumps no revision');
 assert.deepEqual(receipts(file),[],'a dry run opens no receipt');
}

// ---- 2. Apply writes the resolver output with its OWN receipt, a fresh request id, the pre-image and the exact post-write revision ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const run=await R.applyLocalizationReconcile(env,{runId:'run-1',now:clock});
 assert.deepEqual([run.written.length,run.moved.length,run.held.length,run.noop,run.stopped],[1,0,0,0,null]);
 const token=run.written[0];
 assert.deepEqual([token.id,token.preImage,token.postImage.value,token.postImage.status,token.postRevision],[FID,null,'Схватка TMDB','provisional',1]);
 assert.deepEqual(locRow(file),{status:'provisional',source:'tmdb',value:'Схватка TMDB',authority:null});
 assert.equal(revision(file),1,'one revision bump');
 const stored=receipts(file);
 assert.deepEqual(stored.map(r=>[r.operation,r.origin,r.target_id,r.state,r.applied_revision,r.planned_revision]),[['film_localization_reconcile','localization_reconciler',FID,'applied',1,0]],'one applied receipt of the reconciler kind, atomic with the write');
 assert.equal(stored[0].request_id,token.requestId);
 assert.deepEqual(sourceRows(file),[{source:'tmdb',value:'Схватка TMDB',observed_at:T1}],'no source row is written or changed');
 // no resolver difference for the old code path: the same row, read by the pre-ADR reader, gives the same effective value
 assert.deepEqual((await oldReader(env)).value,'Схватка TMDB');
 // the same Film is now a no-op: nothing to write, no receipt, a second run with the same run id replays nothing and writes nothing
 const again=await R.applyLocalizationReconcile(env,{runId:'run-1',now:clock});
 assert.deepEqual([again.written.length,again.noop,receipts(file).length,revision(file)],[0,1,1,1],'replay of the same run id is a no-op: the applied receipt and row stand');
 assert.deepEqual((await R.dryRunLocalizationReconcile(env,{now:clock})).noop,1);
}

// ---- 3. Owner-only change: a stale marked owner projection after the decision is removed, no new observation ----
{
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 await P.writeFilmLocalizationProjection(env,{id:FID,expectedRevision:revision(file),at:T,requestId:'req-1',sources:[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}],inputs:await P.readProjectionInputs(env,FID,[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}])});
 assert.equal(locRow(file).authority,'owner');
 // nothing is stale while the decision stands
 assert.equal((await R.dryRunLocalizationReconcile(env,{now:clock})).noop,1);
 ownerCommit(file,{value:null});
 const stale=await R.dryRunLocalizationReconcile(env,{now:clock});
 assert.deepEqual([stale.stale.length,stale.stale[0].effective],[1,{value:'Схватка',tier:'automatic',source:'tmdb'}]);
 const rev=revision(file);
 const run=await R.applyLocalizationReconcile(env,{runId:'run-2',now:clock});
 assert.deepEqual([run.written.length,locRow(file),revision(file)],[1,{status:'provisional',source:'tmdb',value:'Схватка',authority:null},rev+1]);
 assert.equal(run.written[0].preImage.authority,'owner','the pre-image is the owner projection row');
 // owner CHANGE (value) instead of removal: the new value is materialized by the same reconciler
 const file2=database();seedFilm(file2);addOwner(file2);
 const env2={DB:d1Standin(file2)};
 const s=[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(env2,{id:FID,expectedRevision:0,at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env2,FID,s)});
 ownerCommit(file2,{value:'Жара 2'});
 const run2=await R.applyLocalizationReconcile(env2,{runId:'run-3',now:clock});
 assert.deepEqual([run2.written.length,locRow(file2).value,locRow(file2).authority],[1,'Жара 2','owner']);
 // an owner-only value with no row at all (an owner entry for a Film whose row was never projected) is materialized as the owner projection
 const file3=database();seedFilm(file3);addOwner(file3);
 const run3=await R.applyLocalizationReconcile({DB:d1Standin(file3)},{runId:'run-4',now:clock});
 assert.deepEqual([run3.written.length,dimRow(file3,'localization').authority,JSON.parse(dimRow(file3,'localization').provenance_json).projection],[1,'owner','owner_review']);
}

// ---- 4. Held cases write nothing and manufacture no decision ----
{
 // an owner projection whose decision is gone and no automatic source to replace it
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 const s=[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(env,{id:FID,expectedRevision:0,at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env,FID,s)});
 exec(file,"DELETE FROM film_localization_source");
 ownerCommit(file,{value:null});
 const before=snapshotRows(file);
 const run=await R.applyLocalizationReconcile(env,{runId:'run-h1',now:clock});
 assert.deepEqual([run.written.length,run.held,receipts(file).length,snapshotRows(file)===before],[0,[{id:FID,reason:'owner_projection_without_input'}],0,true]);
 // a genuine legacy owner row of another value than the current owner entry stays protected
 const file2=database();seedFilm(file2);reviewedRow(file2,{value:'Чужое',authority:'owner',source:'owner'});addOwner(file2);
 const run2=await R.applyLocalizationReconcile({DB:d1Standin(file2)},{runId:'run-h2',now:clock});
 assert.deepEqual([run2.written.length,run2.held[0].reason,locRow(file2).value],[0,'protected_row_differs','Чужое']);
 // a genuine legacy owner row with no entry is a match, never replaced
 const file3=database();staleFilm(file3,FID,'1656');reviewedRow(file3,{value:'Жара',authority:'owner',source:'owner'});
 const run3=await R.applyLocalizationReconcile({DB:d1Standin(file3)},{runId:'run-h3',now:clock});
 assert.deepEqual([run3.written.length,run3.noop,locRow(file3).value],[0,1,'Жара']);
 // two different owner values
 const file4=database();seedFilm(file4);addOwner(file4,{key:'a',value:'А'});addOwner(file4,{key:'b',value:'Б'});
 const run4=await R.applyLocalizationReconcile({DB:d1Standin(file4)},{runId:'run-h4',now:clock});
 assert.deepEqual([run4.written.length,run4.held[0].reason],[0,'owner_conflict']);
}

// ---- 5. Legacy provisional candidate is preserved losslessly as a source row, never lost ----
{
 const file=database();seedFilm(file);
 exec(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','letterboxd','v1',NULL,'Старое',NULL,0,'none','"+T+"')");
 sourceRow(file,FID,'tmdb','Схватка TMDB',T1);
 const env={DB:d1Standin(file)};
 const run=await R.applyLocalizationReconcile(env,{runId:'run-l1',now:clock});
 // letterboxd ranks above tmdb in the fixed order, so the stored row already is the resolver output of {letterboxd legacy, tmdb}: a no-op that loses nothing
 assert.deepEqual([run.written.length,run.noop,locRow(file).value],[0,1,'Старое']);
 // a stale legacy row (a lower-order source than a stored source row): the row is replaced, and the legacy candidate is recorded first
 const file2=database();seedFilm(file2);
 exec(file2,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','epg','v1',NULL,'Эпг',NULL,0,'none','"+T+"')");
 sourceRow(file2,FID,'tmdb','Схватка TMDB',T1);
 const env2={DB:d1Standin(file2)};
 const run2=await R.applyLocalizationReconcile(env2,{runId:'run-l2',now:clock});
 assert.equal(run2.written.length,1);
 assert.deepEqual([locRow(file2).value,sourceRows(file2).map(r=>r.source)],['Схватка TMDB',['epg','tmdb']],'the legacy candidate is now a durable source row');
}

// ---- 6. Caps: examine limit, write cap, cursor paging, invalid caps ----
{
 const file=database();
 for(const [i,id] of ['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:tmdb:4'].entries())staleFilm(file,id,String(i+1),'Т'+i);
 const env={DB:d1Standin(file)};
 const dry=await R.dryRunLocalizationReconcile(env,{limit:3,writeCap:2,now:clock});
 assert.deepEqual([dry.examined,dry.stale.length,dry.wouldWrite,dry.hasMore,dry.cursor],[3,3,2,true,'film:tmdb:3'],'the dry run examines at most `limit` Films and reports what a capped run would write');
 const before=receipts(file).length;
 const one1=await R.applyLocalizationReconcile(env,{runId:'run-c1',limit:4,writeCap:2,now:clock});
 assert.deepEqual([one1.written.length,one1.stopped,one1.hasMore,one1.cursor,receipts(file).length-before],[2,'write_cap',true,'film:tmdb:2',2],'the run stops writing at the cap and names where to continue');
 assert.deepEqual(rows(file,"SELECT film_id FROM film_dimension WHERE dimension='localization' ORDER BY film_id").map(r=>r.film_id),['film:tmdb:1','film:tmdb:2']);
 const two=await R.applyLocalizationReconcile(env,{runId:'run-c2',after:one1.cursor,limit:4,writeCap:2,now:clock});
 assert.deepEqual([two.written.length,two.stopped,two.hasMore],[2,null,false]);
 for(const bad of [0,-1,1.5,51,'3'])await assert.rejects(()=>R.dryRunLocalizationReconcile(env,{limit:bad}),code('film_person_invalid'));
 await assert.rejects(()=>R.applyLocalizationReconcile(env,{runId:'r',writeCap:26}),code('film_person_invalid'));
 await assert.rejects(()=>R.applyLocalizationReconcile(env,{runId:''}),code('film_person_invalid'));
 await assert.rejects(()=>R.dryRunLocalizationReconcile(env,{after:'person:x'}),code('film_person_invalid'));
}

// ---- 7. Concurrent mutation: a moved resolver input, a moved revision, a moved owner decision; nothing is written and the caller replans ----
{
 const file=database();staleFilm(file,FID,'1656');addOwner(file);
 const env={DB:d1Standin(file)};
 const planned=await R.readReconcilePlan(env,FID,{at:T3});
 const base={id:FID,inputs:planned.inputs,at:T3,requestId:'r-1',expectedRevision:planned.revision};
 // a new source observation arrives after the plan
 sourceRow(file,FID,'letterboxd','Новое',T2,'other');
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env,base),code('localization_inputs_moved'));
 // an owner-only change after the plan
 const planned2=await R.readReconcilePlan(env,FID,{at:T3});
 ownerCommit(file,{value:'Жара 2'});
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env,{...base,inputs:planned2.inputs}),code('localization_inputs_moved'));
 // another writer bumps the Film revision after the plan
 const planned3=await R.readReconcilePlan(env,FID,{at:T3});
 exec(file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(FID)+",1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1");
 await assert.rejects(()=>R.writeFilmLocalizationReconcile(env,{...base,inputs:planned3.inputs,expectedRevision:planned3.revision}),code('film_person_revision_conflict'));
 assert.equal(locRow(file),null,'every refusal wrote nothing');
}

// ---- 8. Restore: only the exact post-write revision; a later writer refuses it; a second restore refuses ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const run=await R.applyLocalizationReconcile(env,{runId:'run-s1',now:clock});
 const token={id:FID,...run.written[0]};
 const r=await R.restoreLocalizationReconcile(env,{runId:'restore-1',token,now:clock});
 assert.deepEqual([r.state,locRow(file),revision(file)],['applied',null,2],'a pre-image of null removes the row the reconciler created; the revision moves again');
 assert.deepEqual(receipts(file).map(x=>x.operation),['film_localization_reconcile','film_localization_reconcile'],'a restore has its own receipt');
 await assert.rejects(()=>R.restoreLocalizationReconcile(env,{runId:'restore-2',token,now:clock}),code(R.RESTORE_MOVED),'a second restore of the same token is refused');
 // restore of an overwritten row to its previous image
 const file2=database();seedFilm(file2);addOwner(file2);
 const env2={DB:d1Standin(file2)};
 const s=[{source:'tmdb',value:'Схватка',sourceVersion:'v1',provenance:null,observedAt:T1}];
 await P.writeFilmLocalizationProjection(env2,{id:FID,expectedRevision:0,at:T,requestId:'req-1',sources:s,inputs:await P.readProjectionInputs(env2,FID,s)});
 ownerCommit(file2,{value:null});
 const run2=await R.applyLocalizationReconcile(env2,{runId:'run-s2',now:clock});
 const token2={id:FID,...run2.written[0]};
 assert.equal(locRow(file2).authority,null);
 const back=await R.restoreLocalizationReconcile(env2,{runId:'restore-3',token:token2,now:clock});
 assert.deepEqual([back.state,locRow(file2).authority,locRow(file2).value],['applied','owner','Жара'],'the exact pre-image row (the marked owner projection) is back');
 // another writer moved the Film after the reconciler: the restore is refused and nothing is changed
 const file3=database();staleFilm(file3,FID,'1656');
 const env3={DB:d1Standin(file3)};
 const run3=await R.applyLocalizationReconcile(env3,{runId:'run-s3',now:clock});
 exec(file3,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id="+q(FID));
 const after=snapshotRows(file3);
 await assert.rejects(()=>R.restoreLocalizationReconcile(env3,{runId:'restore-4',token:{id:FID,...run3.written[0]},now:clock}),code(R.RESTORE_MOVED));
 assert.equal(snapshotRows(file3),after,'a refused restore writes nothing');
 // the same revision but a changed row (an out-of-band edit) is refused too
 const file4=database();staleFilm(file4,FID,'1656');
 const env4={DB:d1Standin(file4)};
 const run4=await R.applyLocalizationReconcile(env4,{runId:'run-s4',now:clock});
 exec(file4,"UPDATE film_dimension SET value='Иное' WHERE film_id="+q(FID)+" AND dimension='localization'");
 await assert.rejects(()=>R.restoreLocalizationReconcile(env4,{runId:'restore-5',token:{id:FID,...run4.written[0]},now:clock}),code(R.RESTORE_MOVED));
 assert.equal(locRow(file4).value,'Иное');
 // forward correction: the same reconciler corrects it afterwards (the resolver output of the stored sources)
 const fwd=await R.applyLocalizationReconcile(env4,{runId:'run-s5',now:clock});
 assert.deepEqual([fwd.written.length,locRow(file4).value],[1,'Схватка TMDB'],'the forward correction returns the row to the resolver output of the stored sources, under a new receipt and a new pre-image');
}

// ---- 9. Gates: marker not open, owner domain not D1, a redirect, a missing Film ----
{
 const file=database();staleFilm(file,FID,'1656');
 exec(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(()=>R.applyLocalizationReconcile({DB:d1Standin(file)},{runId:'g1',now:clock}),error=>typeof error.code==='string'&&error.code.startsWith('film_person'));
 assert.equal(locRow(file),null);
 const file2=database({owner:'r2'});staleFilm(file2,FID,'1656');
 const env2={DB:d1Standin(file2)};
 const dry=await R.dryRunLocalizationReconcile(env2,{now:clock});
 assert.deepEqual([dry.stale.length,dry.unavailable],[0,[{id:FID,code:'localization_owner_unavailable'}]],'owner evidence that cannot be proven is never read as a decision');
 await assert.rejects(()=>R.applyLocalizationReconcile(env2,{runId:'g2',now:clock}),code('localization_owner_unavailable'));
 const file3=database();staleFilm(file3,FID,'1656');seedFilm(file3,OTHER,'9999');
 exec(file3,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(OTHER)+","+q(FID)+",'"+T+"')");
 const dry3=await R.dryRunLocalizationReconcile({DB:d1Standin(file3)},{now:clock});
 assert.equal(dry3.examined,1,'a redirected Film is never a candidate');
}

// ---- 10. Delivery runs nothing: no importer outside the tests, no side effect on import, no route, flag, Task, schema or Worker entry ----
{
 const importers=[];
 for(const dir of ['src','scripts','public','.github']){
  const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name==='node_modules'?[]:walk(path.join(d,e.name))):[path.join(d,e.name)]):[];
  for(const file of walk(dir))if(!file.endsWith('src/film-localization-reconciler.js')&&/\.(js|mjs|yml|yaml|json|html)$/.test(file)&&fs.readFileSync(file,'utf8').includes('film-localization-reconciler.js'))importers.push(file);
 }
 assert.deepEqual(importers,[],'no Worker, route, MCP tool, Workflow, cron, script or workflow imports the reconciler');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('film-localization-reconciler.js'),'the build does not bundle it');
 // importing and constructing the registry spec touches no database
 const spec=R.filmLocalizationReconcileOperation({});
 assert.equal(spec.atomic,true);
 const {OPERATION_KINDS}=await load('canonical-receipts.js');
 assert.ok(OPERATION_KINDS.includes(R.RECONCILE_OPERATION));
 assert.ok(!chain.some(name=>fs.readFileSync('migrations/'+name,'utf8').includes('film_localization_reconcile')),'no migration, table, index or column belongs to the reconciler');
}

// ---- 11. Registry spec: a historical receipt of another kind is never reached; a noop readback is unproven (needs review), a moved input abandons ----
{
 const file=database();staleFilm(file,FID,'1656');
 const env={DB:d1Standin(file)};
 const spec=R.filmLocalizationReconcileOperation({now:clock});
 const planned=await R.readReconcilePlan(env,FID,{at:T3});
 const digest=await R.reconcileDigest({id:FID,inputs:planned.inputs,preImage:planned.plan.preImage,postImage:planned.plan.postImage});
 const receipt={requestId:'x',contentDigest:digest,target:{kind:'film',id:FID}};
 assert.deepEqual((await spec.readback(env,receipt.target,receipt)),{digest:null,revision:0},'a write still to do is a replay, not a proof');
 assert.equal(await spec.revalidate(env,receipt),'proceed');
 sourceRow(file,FID,'letterboxd','Новое',T2,'other');
 assert.deepEqual(await spec.readback(env,receipt.target,receipt),{disposition:'abandon',errorClass:'producer_source_changed'},'a moved input abandons: the next run plans afresh');
 assert.equal(await spec.revalidate(env,receipt),'stale');
 // the row equals the output: equal content is never a proof of causality
 const file2=database();staleFilm(file2,FID,'1656');
 const env2={DB:d1Standin(file2)};
 const p2=await R.readReconcilePlan(env2,FID,{at:T3});
 const d2=await R.reconcileDigest({id:FID,inputs:p2.inputs,preImage:p2.plan.preImage,postImage:p2.plan.postImage});
 await R.applyLocalizationReconcile(env2,{runId:'z',now:clock});
 const r2={requestId:'y',contentDigest:d2,target:{kind:'film',id:FID}};
 const seen=await R.filmLocalizationReconcileOperation({now:clock}).readback(env2,r2.target,r2);
 assert.equal(seen.evidence,undefined);
 assert.notEqual(seen.digest,undefined);
}
console.log('film-localization-reconciler: ok');
