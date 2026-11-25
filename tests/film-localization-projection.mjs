// AIR-662 / ADR 0218 stage 3 (decisions 3, 5 and 6; options D1, C1, B1): the projection-aware localization write, the identity row created on a ranked
// title write, and the W1/W4 metadata lock refusals, on real SQLite (the sqlite3-CLI D1 stand-in). No Worker, R2 or Cloudflare access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// FILM_PROJECTION_MODULE (tests/film-localization-projection-mutation.mjs only): a mutant copy of src/film-localization-projection.js for sections 1-4 and 9.
const load=name=>import(pathToFileURL(path.resolve('src',name)).href);
const P=process.env.FILM_PROJECTION_MODULE?await import(pathToFileURL(path.resolve(process.env.FILM_PROJECTION_MODULE)).href):await load('film-localization-projection.js');
const W=await load('canonical-film-writers.js');
const MS=await load('canonical-metadata-sync-producer.js');
const {mergeFilms,metadataLocked}=await load('canonical-mutations.js');
const {loadLocalizationInputs,resolveLocalization}=await load('localization-sources.js');
const {producerRequestId,reconcileOwnOrigin}=await load('canonical-producer-adapters.js');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-projection-'));
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
// owner: 'd1' (the production state of the owner-review domain) or 'r2' (not authoritative).
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
// An owner-review commit: every row moves to the new generation (as src/owner-review-d1.js commits), with this payload for one key.
const ownerCommit=(file,{key='tmdb_1656',value})=>exec(file,"UPDATE owner_review_authority SET generation=generation+1 WHERE id=1;UPDATE owner_review_entry SET generation=(SELECT generation FROM owner_review_authority WHERE id=1);"+(value===null?"DELETE FROM owner_review_entry WHERE source_key="+q(key)+";":"UPDATE owner_review_entry SET payload_json="+q(ownerPayload(value))+" WHERE source_key="+q(key)+";"));
const src=(source,value,observedAt,extra={})=>({source,value,sourceVersion:'v1',provenance:null,observedAt,...extra});
// `inputs` is the resolver-input proof a producer plans from (projectionInputs); the default reads it fresh, a test passes a stale one to prove the refusal.
const write=async(env,file,sources,{requestId='req-1',at=T,expectedRevision,inputs}={})=>P.writeFilmLocalizationProjection(env,{id:FID,expectedRevision:expectedRevision??revision(file),at,requestId,sources,inputs:inputs??await P.readProjectionInputs(env,FID,sources)});
const reviewedRow=(file,{value='Словарь',authority='dictionary',source='dictionary',id=FID}={})=>exec(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(id)+",'localization','reviewed',"+q(source)+",'verified',NULL,"+q(value)+","+q(authority)+",0,'keep_reviewed','"+T+"')");
// The old reader path (rollback compatibility): the effective value the pre-ADR code computes from the same columns with the same resolver.
const oldReader=async(env,id=FID)=>resolveLocalization((await loadLocalizationInputs(env,'film',[id])).get(id));

// ---- 1. Cross-source order (fixed order before time) and a new Film with no dimension row (F5 closed) ----
{
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const out=await write(env,file,[src('tmdb','Схватка TMDB',T1)]);
 assert.equal(out.written,true);
 assert.deepEqual(locRow(file),{status:'provisional',source:'tmdb',value:'Схватка TMDB',authority:null},'the projection is written in the same batch as the source');
 assert.equal(revision(file),1,'one revision bump for source plus projection');
 // letterboxd observed EARLIER than tmdb still wins: the fixed source order comes before the observation time (no newest-wins rule)
 const later=await write(env,file,[src('letterboxd','Схватка LB',T)],{requestId:'req-2'});
 assert.deepEqual(later.effective,{value:'Схватка LB',tier:'automatic',source:'letterboxd'});
 assert.deepEqual(locRow(file),{status:'provisional',source:'letterboxd',value:'Схватка LB',authority:null});
 // a lower-ranked newer source writes its source row and leaves the projection
 const epg=await write(env,file,[src('epg','Схватка EPG',T3)],{requestId:'req-3'});
 assert.deepEqual([epg.written,epg.changes],[true,['source:epg']]);
 assert.equal(locRow(file).source,'letterboxd');
 assert.deepEqual((await oldReader(env)).value,'Схватка LB','rollback: the old reader resolves the same value from the same columns');
}

// ---- 2. Stale, replay, replay mismatch, no-op ----
{
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 await write(env,file,[src('tmdb','A',T2)]);
 const batches=env.DB.calls.batches;
 const replay=await write(env,file,[src('tmdb','A',T2)]);
 assert.deepEqual([replay.written,replay.reason,replay.skipped],[false,'unchanged',[{field:'source:tmdb',reason:'replay'}]]);
 assert.equal(env.DB.calls.batches,batches,'a replay opens no batch');
 await assert.rejects(()=>write(env,file,[src('tmdb','B',T2)]),code('localization_replay_mismatch'));
 const stale=await write(env,file,[src('tmdb','Old',T1)],{requestId:'req-stale'});
 assert.deepEqual([stale.written,stale.reason,stale.skipped],[false,'superseded',[{field:'source:tmdb',reason:'stale'}]],'a superseded source is not an unchanged one');
 assert.deepEqual(sourceRows(file),[{source:'tmdb',value:'A',observed_at:T2}]);
 // no-op projection: a newer observation of the same value rewrites only the source row (the projection row's clock follows the effective observation)
 const sources=[src('epg','Other',T3)];
 const plan=P.planFilmLocalizationProjection(await W.readFilmSnapshot(env,FID),await P.readOwnerReviewToken(env,FID),{id:FID,at:T,requestId:'req-x',sources,inputs:await P.readProjectionInputs(env,FID,sources)});
 assert.deepEqual(plan.changes,['source:epg'],'the resolver output equals the stored row: no projection statement');
 assert.equal(plan.statements.filter(([sql])=>sql.startsWith('INSERT INTO film_dimension')).length,0);
}

// ---- 3. Owner and reviewed inputs: owner is MATERIALIZED, a protected row of another value HOLDS (nothing written), a lower tier never replaces a higher one ----
{
 // (a) a verified owner entry and NO stored row: the owner projection is written with the source (the display readers read the stored row)
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 const out=await write(env,file,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([out.written,out.effective.tier,out.changes],[true,'owner',['source:tmdb','dimension:localization']]);
 assert.deepEqual(locRow(file),{status:'reviewed',source:'owner',value:'Жара',authority:'owner'},'the stored row is the owner projection, no new review decision beyond the owner entry');
 assert.deepEqual(sourceRows(file).map(row=>row.source),['tmdb']);
 assert.equal((await oldReader(env)).value,'Жара','rollback: the old reader resolves the same value from the same columns');
 // the same owner value stored already: only the source is written; a later source never replaces the owner row
 const again=await write(env,file,[src('letterboxd','Авто',T2)],{requestId:'req-2'});
 assert.deepEqual([again.written,again.changes,locRow(file).value],[true,['source:letterboxd'],'Жара']);
 // (b) a provisional stored row of another value is replaced by the owner projection
 const file2=database();seedFilm(file2);
 const env2={DB:d1Standin(file2)};
 await write(env2,file2,[src('tmdb','Схватка',T1)]);
 assert.equal(locRow(file2).status,'provisional');
 addOwner(file2);
 const swap=await write(env2,file2,[src('epg','Другое',T2)],{requestId:'req-2'});
 assert.deepEqual([swap.effective.tier,locRow(file2)],['owner',{status:'reviewed',source:'owner',value:'Жара',authority:'owner'}]);
 // (c) a reviewed dictionary row of ANOTHER value than the owner entry is protected: held, NOTHING written (not even the source), non-positive proof
 const file3=database();seedFilm(file3);reviewedRow(file3);addOwner(file3);
 const env3={DB:d1Standin(file3)};
 const held=await write(env3,file3,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([held.written,held.held,held.reason],[false,true,'protected_row_differs']);
 assert.deepEqual([sourceRows(file3),locRow(file3),revision(file3),env3.DB.calls.batches],[[],{status:'reviewed',source:'dictionary',value:'Словарь',authority:'dictionary'},0,0]);
 // an owner-authority row of another value is protected too; an equal value is a match (the source is written, the row is not rewritten)
 const file3b=database();seedFilm(file3b);reviewedRow(file3b,{value:'Чужое',authority:'owner',source:'owner'});addOwner(file3b);
 assert.equal((await write({DB:d1Standin(file3b)},file3b,[src('tmdb','x',T1)])).reason,'protected_row_differs');
 const file3c=database();seedFilm(file3c);reviewedRow(file3c,{value:'Жара',authority:'dictionary'});addOwner(file3c);
 const equal=await write({DB:d1Standin(file3c)},file3c,[src('tmdb','x',T1)]);
 assert.deepEqual([equal.written,equal.changes,locRow(file3c).authority],[true,['source:tmdb'],'dictionary'],'an equal reviewed value matches: only the source is written');
 // (d) a reviewed dictionary row and NO owner entry: reviewed is the effective tier, the stored row matches, the source is written
 const file4=database();seedFilm(file4);reviewedRow(file4);
 const kept=await write({DB:d1Standin(file4)},file4,[src('letterboxd','Авто',T1)]);
 assert.deepEqual([kept.effective.tier,kept.changes,locRow(file4).value],['reviewed',['source:letterboxd'],'Словарь']);
 // (e) a reviewed row without a value cannot be replaced by the automatic winner under the guard: held
 const file5=database();seedFilm(file5);
 exec(file5,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','reviewed','dictionary','verified',NULL,NULL,'dictionary',0,'keep_reviewed','"+T+"')");
 const blank=await write({DB:d1Standin(file5)},file5,[src('tmdb','Авто',T1)]);
 assert.deepEqual([blank.held,blank.reason,sourceRows(file5)],[true,'protected_row_differs',[]]);
 // (f) a verified owner value of a retired id that redirects to the Film counts (owner_review_entry links are snapshots a merge does not rewrite)
 const file6=database();seedFilm(file6);
 exec(file6,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old-1',"+q(FID)+",'"+T+"')");
 addOwner(file6,{key:'old-1',link:'film:old-1',value:'Старая жара'});
 const out6=await write({DB:d1Standin(file6)},file6,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([out6.effective.tier,locRow(file6).value],['owner','Старая жара']);
 // (g) two different verified owner values: owner_conflict is HELD (nothing written, non-positive proof), never one chosen
 const file7=database();seedFilm(file7);addOwner(file7);addOwner(file7,{key:'heat-1995',value:'Другая'});
 const env7={DB:d1Standin(file7)};
 const conflict=await write(env7,file7,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([conflict.held,conflict.reason,conflict.effective.tier,sourceRows(file7),locRow(file7),env7.DB.calls.batches],[true,'owner_conflict','owner_conflict',[],null,0]);
 // (h) the persisted projection equals the resolver output on the rows read back (the proof of the readback)
 const proof=await P.filmLocalizationProjectionState(env,{id:FID,at:T,requestId:'req-1',sources:[src('tmdb','Схватка',T1)],inputs:await P.readProjectionInputs(env,FID,[src('tmdb','Схватка',T1)])});
 assert.equal(proof.state,'exact');
}

// ---- 4. Fences: an owner-only change and a dictionary review between plan and commit refuse the batch; the replan is correct ----
{
 // (a) owner-only change in owner_review_entry: the Film revision does not move, the owner-review token does
 const file=database();seedFilm(file);addOwner(file,{value:'Жара'});
 let fire=true;
 const env={DB:d1Standin(file,{onBatch:async statements=>{if(fire&&statements.some(item=>/film_localization_source/.test(item.text))){fire=false;ownerCommit(file,{value:null});}}})};
 const before=revision(file);
 await assert.rejects(()=>write(env,file,[src('tmdb','Схватка',T1)]),code('localization_owner_moved'));
 assert.deepEqual([sourceRows(file),locRow(file),revision(file)],[[],null,before],'nothing of the refused batch is written');
 const replanned=await write(env,file,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([replanned.effective.tier,locRow(file)?.value],['automatic','Схватка'],'after the owner removal the replan writes the automatic projection');
 // (b) a new owner value lands between plan and commit: refused, then kept
 const file2=database();seedFilm(file2);addOwner(file2,{value:'Жара'});ownerCommit(file2,{value:null});
 let fire2=true;
 const env2={DB:d1Standin(file2,{onBatch:async statements=>{if(fire2&&statements.some(item=>/film_localization_source/.test(item.text))){fire2=false;addOwner(file2,{value:'Новая',generation:2});exec(file2,'UPDATE owner_review_authority SET generation=3 WHERE id=1;UPDATE owner_review_entry SET generation=3');}}})};
 await assert.rejects(()=>write(env2,file2,[src('tmdb','Схватка',T1)]),code('localization_owner_moved'));
 assert.equal(locRow(file2),null);
 assert.equal((await write(env2,file2,[src('tmdb','Схватка',T1)])).effective.tier,'owner');
 assert.deepEqual(locRow(file2),{status:'reviewed',source:'owner',value:'Новая',authority:'owner'},'the replan materializes the new owner value');
 // (c) a concurrent dictionary review (W1, the Film revision moves): the revision CAS refuses; the replan keeps the reviewed row
 const file3=database();seedFilm(file3);
 let fire3=true;
 const env3={DB:d1Standin(file3,{onBatch:async statements=>{if(fire3&&statements.some(item=>/film_localization_source/.test(item.text))){fire3=false;exec(file3,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','reviewed','dictionary','verified','{\"authority\":\"dictionary\"}','Словарь','dictionary',0,'keep_reviewed','"+T+"');INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(FID)+",1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1;");}}})};
 await assert.rejects(()=>write(env3,file3,[src('tmdb','Схватка',T1)],{expectedRevision:0}),code('film_person_revision_conflict'));
 const after=await write(env3,file3,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([after.effective.tier,after.changes,locRow(file3).value],['reviewed',['source:tmdb'],'Словарь'],'the replan sees the reviewed row, keeps it and writes only the source');
 // (c2) the owner-token predicates cover the consumed rows' generation and the redirect closure (ancestors), not only the marker and the row content:
 // a consumed row re-stamped to another generation, a new redirect into the Film with an owner row on its source id, and a redirect that left the closure each refuse the batch
 const trap=async(label,setup,ownerValue='Жара')=>{
  const f=database();seedFilm(f);seedFilm(f,'film:old-9','9');addOwner(f,{value:ownerValue});
  exec(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old-9',"+q(FID)+",'"+T+"')");
  let armed=true;
  const e={DB:d1Standin(f,{onBatch:async statements=>{if(armed&&statements.some(item=>/film_localization_source/.test(item.text))){armed=false;setup(f);}}})};
  await assert.rejects(()=>write(e,f,[src('tmdb','Схватка',T1)]),code('localization_owner_moved'),label);
  assert.deepEqual([sourceRows(f),locRow(f)],[[],null],label+': nothing written');
 };
 await trap('generation of a consumed row',f=>exec(f,"UPDATE owner_review_entry SET generation=99"));
 await trap('closure grew',f=>{exec(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old-10','film:old-9','"+T+"')");addOwner(f,{key:'old-10',link:'film:old-10',value:'Новая жара'});});
 await trap('an ancestor left the closure',f=>exec(f,"DELETE FROM film_redirect WHERE from_id='film:old-9'"));
 // (d) the owner domain is not D1-authoritative: refused before any batch
 const file4=database({owner:'r2'});seedFilm(file4);
 const env4={DB:d1Standin(file4)};
 await assert.rejects(()=>write(env4,file4,[src('tmdb','Схватка',T1)]),code('localization_owner_unavailable'));
 assert.equal(env4.DB.calls.batches,0);
 // (e) never a redirect, never a Film creation
 const file5=database();
 const env5={DB:d1Standin(file5)};
 await assert.rejects(()=>P.writeFilmLocalizationProjection(env5,{id:FID,expectedRevision:0,at:T,requestId:'r',sources:[src('tmdb','X',T1)],inputs:{}}),code('film_person_precondition'));
 assert.equal(env5.DB.calls.batches,0,'an absent Film is refused before any batch');
 seedFilm(file5);seedFilm(file5,OTHER,'9999');exec(file5,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(OTHER)+","+q(FID)+",'"+T+"')");
 await assert.rejects(()=>P.writeFilmLocalizationProjection(env5,{id:OTHER,expectedRevision:0,at:T,requestId:'r',sources:[src('tmdb','X',T1)],inputs:{}}),code('film_person_redirect'));
}

// ---- 5. The receipt kind: the digest binds the resolver inputs, readback proves source AND projection (only `exact`), a moved input replans, historical receipts stay terminal ----
const unit=async(env,sources,id=FID)=>({id,at:T,sources,inputs:await P.readProjectionInputs(env,id,sources)});
{
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const input=await unit(env,[src('wikidata','Схватка',T1)]);
 const out=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'e1',input,now:()=>T});
 assert.equal(out.state,'applied');
 assert.deepEqual(rows(file,"SELECT operation,state FROM canonical_write_receipt"),[{operation:'film_localization_projection',state:'applied'}]);
 assert.equal(locRow(file).value,'Схватка');
 // the readback proves both: removing the projection row makes the proof fail although the source row is still there
 const op=MS.filmLocalizationProjectionOperation({replan:async()=>input});
 const receipt={requestId:out.requestId,contentDigest:await MS.filmProjectionDigest(input),target:{kind:'film',id:FID}};
 assert.equal((await op.readback(env,receipt.target,receipt)).digest,receipt.contentDigest,'exact: this request wrote the source and the row equals the resolver output');
 exec(file,"DELETE FROM film_dimension WHERE film_id="+q(FID)+" AND dimension='localization'");
 const noProof=await op.readback(env,receipt.target,receipt);
 assert.deepEqual([noProof.digest,noProof.disposition],[undefined,'abandon'],'a source row alone is no proof of the projection: never positive, and no projection-only repair under this identity');
 // the digest binds the resolver identity and the kind: the same content under the old kind is another request
 const oldDigest=await MS.localizationDigest(MS.LOCALIZATION_SOURCE_OPERATION,{kind:'film',id:FID,sources:input.sources});
 assert.notEqual(oldDigest,receipt.contentDigest);
 assert.notEqual(await producerRequestId({origin:'metadata_sync',operation:'localization_source',event:'e1',target:{kind:'film',id:FID},digest:oldDigest}),out.requestId);
}
{
 // THE DIGEST BINDS THE RESOLVER INPUTS: the same incoming observation over other inputs is another digest and request identity (owner-only change, dictionary review, another winning source)
 const sources=[src('wikidata','Схватка',T1)];
 const variants={
  plain:()=>{},
  ownerEntry:f=>addOwner(f),
  otherSource:f=>exec(f,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ("+q(FID)+",'letterboxd','Другой','v1','null','other','"+T+"','"+T+"')"),
  reviewedRow:f=>reviewedRow(f),
  legacyProvisional:f=>exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','epg','v1',NULL,'Эфир',NULL,0,'none','"+T+"')"),
  legacyOtherVersion:f=>exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','epg','v2',NULL,'Эфир',NULL,0,'none','"+T+"')"),
  legacyOtherProvenance:f=>exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional','epg','v1','{\"sources\":[\"x\"]}','Эфир',NULL,0,'none','"+T+"')"),
  sameSourceOlder:f=>exec(f,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ("+q(FID)+",'wikidata','Старое','v0','null','prior','2026-11-25T09:00:00.000Z','"+T+"')"),
 };
 const digests=[];let base=null;
 for(const [name,setup] of Object.entries(variants)){
  const f=database();seedFilm(f);setup(f);
  const e={DB:d1Standin(f)};
  const input=await unit(e,sources);
  if(name==='plain'){base=input;}
  digests.push(await MS.filmProjectionDigest(input));
  assert.equal(await MS.filmProjectionDigest(await unit(e,sources)),digests.at(-1),name+': the digest is deterministic over the same inputs');
 }
 assert.equal(new Set(digests).size,digests.length,'an owner entry, another source row, a stored same-source row, a reviewed row and a legacy provisional candidate (its value, version and provenance) each change the content digest of the same observation');
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 addOwner(file);ownerCommit(file,{value:null});
 assert.notEqual(await MS.filmProjectionDigest(await unit(env,sources)),digests[0],'an owner commit alone moves the token');
 reviewedRow(file);
 // a stale proof is refused by the writer (nothing written) and by the apply (settled, replanned by the next sync)
 await assert.rejects(()=>P.writeFilmLocalizationProjection(env,{...base,requestId:'x',expectedRevision:revision(file)}),code('localization_inputs_moved'));
 assert.deepEqual([sourceRows(file),env.DB.calls.batches],[[],0]);
 const skipped=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'stale',input:base,now:()=>T});
 assert.deepEqual([skipped.state,skipped.reason,skipped.receipt],['skipped','localization_inputs_moved',false]);
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
}
{
 // RACE BETWEEN RESERVATION AND WRITE: the receipt is reserved, then a resolver input moves WITHOUT a Film revision change; the writer refuses, the receipt is not applied,
 // the next reconcile abandons it (source changed, no old identity replayed as another effect), and a fresh plan writes the right projection under its own identity
 const file=database();seedFilm(file);
 let fire=true;
 const env={DB:d1Standin(file,{onBatch:async statements=>{if(fire&&statements.some(item=>/INSERT INTO canonical_write_receipt/.test(item.text))){fire=false;reviewedRow(file);}}})};
 const input=await unit(env,[src('wikidata','Схватка',T1)]);
 const out=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'race',input,now:()=>T}).catch(error=>({state:'threw',code:error.code}));
 assert.notEqual(out.state,'applied',JSON.stringify(out));
 assert.deepEqual([sourceRows(file),locRow(file).source],[[],'dictionary'],'nothing of the refused unit is written; the reviewed row is untouched');
 const pending=rows(file,'SELECT request_id,state FROM canonical_write_receipt')[0];
 assert.notEqual(pending.state,'applied');
 const later=()=>new Date(Date.parse(T)+86400000).toISOString();
 const intent=[{requestId:pending.request_id,operation:'film_localization_projection',origin:'metadata_sync',event:'race',target:{kind:'film',id:FID},input}];
 await reconcileOwnOrigin(env,{origin:'metadata_sync',operations:MS.metadataSyncRegistry(env,{intent,now:later}),now:later});
 assert.deepEqual(rows(file,'SELECT state,error_class FROM canonical_write_receipt'),[{state:'abandoned',error_class:'producer_source_changed'}]);
 assert.equal(sourceRows(file).length,0,'the abandoned receipt wrote nothing');
 const fresh=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'race2',input:await unit(env,[src('wikidata','Схватка',T1)]),now:later});
 assert.equal(fresh.state,'applied');
 assert.deepEqual(locRow(file).source,'dictionary','the replanned write keeps the reviewed row and records the source');
}
{
 // RECOVERY of a NEW receipt whose batch failed before commit: pending, then the reconcile reads back (not exact: a write is still to do) and replays the SAME request id
 const file=database();seedFilm(file);
 let fail=true;
 const env={DB:d1Standin(file,{onBatch:async statements=>{if(fail&&statements.some(item=>/INSERT INTO film_localization_source/.test(item.text))){fail=false;throw new Error('network connection lost');}}})};
 const input=await unit(env,[src('wikidata','Схватка',T1)]);
 const first=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'rec',input,now:()=>T}).catch(error=>({state:'threw',code:error.code}));
 assert.notEqual(first.state,'applied');
 const pending=rows(file,'SELECT request_id,state FROM canonical_write_receipt')[0];
 assert.notEqual(pending.state,'applied');
 assert.deepEqual([sourceRows(file),locRow(file)],[[],null]);
 const op=MS.filmLocalizationProjectionOperation({replan:async()=>input});
 const receipt={requestId:pending.request_id,contentDigest:await MS.filmProjectionDigest(input),target:{kind:'film',id:FID}};
 assert.equal((await op.readback(env,receipt.target,receipt)).digest,null,'a write still to do is no proof');
 const later=()=>new Date(Date.parse(T)+86400000).toISOString();
 const intent=[{requestId:pending.request_id,operation:'film_localization_projection',origin:'metadata_sync',event:'rec',target:{kind:'film',id:FID},input}];
 await reconcileOwnOrigin(env,{origin:'metadata_sync',operations:MS.metadataSyncRegistry(env,{intent,now:later}),now:later});
 assert.deepEqual(rows(file,'SELECT operation,state FROM canonical_write_receipt'),[{operation:'film_localization_projection',state:'applied'}]);
 assert.deepEqual([sourceRows(file).map(row=>row.source),locRow(file).value],[['wikidata'],'Схватка'],'the replay under the SAME request id wrote source and projection atomically');
}
{
 // The readback states: held, superseded and moved are NEVER a positive proof; they abandon with a named class
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const sources=[src('wikidata','Схватка',T1)];
 const input=await unit(env,sources);
 const op=MS.filmLocalizationProjectionOperation({replan:async()=>input});
 const receipt={requestId:'rb-1',contentDigest:await MS.filmProjectionDigest(input),target:{kind:'film',id:FID}};
 const look=async()=>op.readback(env,receipt.target,receipt);
 assert.deepEqual([(await look()).digest,(await look()).disposition],[null,undefined],'nothing written yet: replay');
 // moved: the reviewed row appeared after the plan
 reviewedRow(file);
 assert.deepEqual(await look(),{disposition:'abandon',errorClass:'producer_source_changed'});
 // held: planned over a reviewed row of another value than a later owner entry
 const file2=database();seedFilm(file2);reviewedRow(file2);
 const env2={DB:d1Standin(file2)};
 const input2=await unit(env2,sources);
 addOwner(file2);
 const op2=MS.filmLocalizationProjectionOperation({replan:async()=>input2});
 const receipt2={requestId:'rb-2',contentDigest:await MS.filmProjectionDigest(input2),target:{kind:'film',id:FID}};
 // the owner token moved, so the resolver inputs moved: source changed (a held decision needs unmoved inputs)
 assert.equal((await op2.readback(env2,receipt2.target,receipt2)).errorClass,'producer_source_changed');
 const input3=await unit(env2,sources);
 const op3=MS.filmLocalizationProjectionOperation({replan:async()=>input3});
 const receipt3={requestId:'rb-3',contentDigest:await MS.filmProjectionDigest(input3),target:{kind:'film',id:FID}};
 assert.deepEqual(await op3.readback(env2,receipt3.target,receipt3),{disposition:'abandon',errorClass:'localization_projection_held'},'held: a reviewed row of another value than the owner entry is never proven');
 assert.equal(await op3.revalidate(env2,receipt3),'stale');
 // moved: a newer observation of the SAME source from another request arrives after the plan (the stored same-source row is part of the proof)
 const file4=database();seedFilm(file4);
 const env4={DB:d1Standin(file4)};
 const input4=await unit(env4,sources);
 const newer=()=>exec(file4,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ("+q(FID)+",'wikidata','Новее','v1','null','other','"+T3+"','"+T3+"')");
 newer();
 const op4=MS.filmLocalizationProjectionOperation({replan:async()=>input4});
 const receipt4={requestId:'rb-4',contentDigest:await MS.filmProjectionDigest(input4),target:{kind:'film',id:FID}};
 assert.deepEqual(await op4.readback(env4,receipt4.target,receipt4),{disposition:'abandon',errorClass:'producer_source_changed'});
 await assert.rejects(()=>P.writeFilmLocalizationProjection(env4,{...input4,requestId:'rb-4',expectedRevision:revision(file4)}),code('localization_inputs_moved'));
 assert.equal(locRow(file4),null,'no projection-only repair under the old identity');
 // superseded: the source is ALREADY stale when planned (the newer row is in the proof): nothing is written, no projection-only repair, never a proof
 const input5=await unit(env4,sources);
 const op5=MS.filmLocalizationProjectionOperation({replan:async()=>input5});
 const receipt5={requestId:'rb-5',contentDigest:await MS.filmProjectionDigest(input5),target:{kind:'film',id:FID}};
 assert.deepEqual(await op5.readback(env4,receipt5.target,receipt5),{disposition:'abandon',errorClass:'superseded_by_newer_observation'});
 assert.equal(await op5.revalidate(env4,receipt5),'superseded');
 const direct=await P.writeFilmLocalizationProjection(env4,{...input5,requestId:'rb-5',expectedRevision:revision(file4)});
 assert.deepEqual([direct.written,direct.reason,locRow(file4),env4.DB.calls.batches],[false,'superseded',null,0]);
}
{
 // a historical APPLIED source receipt stays terminal: returned as-is, never replayed as a projection write, skipped by reconciliation
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const old={kind:'film',id:FID,at:T,sources:[src('wikidata','Схватка',T1)]};
 const applied=await MS.applyLocalizationSource(env,{origin:'metadata_sync',event:'old',input:old,now:()=>T});
 assert.equal(applied.state,'applied');
 assert.equal(locRow(file),null,'the historical source-only write left the projection stale (F5)');
 const again=await MS.applyLocalizationSource(env,{origin:'metadata_sync',event:'old',input:old,now:()=>T});
 assert.equal(again.state,'noop','the same content is a no-op pre-plan, never a projection write');
 const reconciled=await reconcileOwnOrigin(env,{origin:'metadata_sync',operations:MS.metadataSyncRegistry(env,{intent:[],now:()=>T2}),now:()=>T2});
 assert.equal(reconciled.considered??0,0,'an applied receipt is not considered');
 assert.deepEqual([rows(file,'SELECT state FROM canonical_write_receipt')[0].state,locRow(file)],['applied',null],'only the separate reconciler (AIR-663) fixes the projection');
}
{
 // an UNSETTLED old receipt (unknown outcome) settles as the old operation: source-only readback, no projection row
 const file=database();seedFilm(file);
 let fail=true;
 const env={DB:d1Standin(file,{onBatch:async statements=>{if(fail&&statements.some(item=>/INSERT INTO film_localization_source/.test(item.text))){fail=false;throw new Error('network connection lost');}}})};
 const old={kind:'film',id:FID,at:T,sources:[src('wikidata','Схватка',T1)]};
 const first=await MS.applyLocalizationSource(env,{origin:'metadata_sync',event:'old2',input:old,now:()=>T}).catch(error=>({state:'threw',code:error.code}));
 assert.notEqual(first.state,'applied');
 const pending=rows(file,'SELECT request_id,operation,state FROM canonical_write_receipt')[0];
 assert.equal(pending.operation,'localization_source');assert.notEqual(pending.state,'applied');
 const intent=[{requestId:pending.request_id,operation:'localization_source',origin:'metadata_sync',event:'old2',target:{kind:'film',id:FID},input:old}];
 const later=()=>new Date(Date.parse(T)+86400000).toISOString();
 await reconcileOwnOrigin(env,{origin:'metadata_sync',operations:MS.metadataSyncRegistry(env,{intent,now:later}),now:later});
 assert.deepEqual(rows(file,'SELECT operation,state FROM canonical_write_receipt'),[{operation:'localization_source',state:'applied'}],'settled under its own kind');
 assert.deepEqual([sourceRows(file).length,locRow(file)],[1,null],'old rules: the source row, no projection');
}

// ---- 5b. Receipted end to end: a newer same-source observation and a moved input never become a projection-only repair under the old identity ----
{
 const sources=[src('wikidata','Схватка',T1)];
 const newerRow=f=>exec(f,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ("+q(FID)+",'wikidata','Новее','v1','null','other','"+T3+"','"+T3+"')");
 // (a) the newer observation lands between the plan and the apply: a settled skip, no receipt, nothing written
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const planned=await unit(env,sources);
 newerRow(file);
 const skipped=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'s1',input:planned,now:()=>T});
 assert.deepEqual([skipped.state,skipped.reason,one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),locRow(file)],['skipped','localization_inputs_moved',0,null]);
 // (b) it is already stored when planned: superseded, a noop outcome, no receipt, no projection-only repair
 const stale=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'s2',input:await unit(env,sources),now:()=>T});
 assert.deepEqual([stale.state,one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),locRow(file)],['noop',0,null]);
 // (c) it lands between the reservation and the write: the writer refuses, the receipt is not applied and the next reconcile abandons it (the projection is never repaired under it)
 const file2=database();seedFilm(file2);
 let fire=true;
 const env2={DB:d1Standin(file2,{onBatch:async statements=>{if(fire&&statements.some(item=>/INSERT INTO canonical_write_receipt/.test(item.text))){fire=false;newerRow(file2);}}})};
 const input2=await unit(env2,sources);
 const out=await MS.applyFilmLocalizationProjection(env2,{origin:'metadata_sync',event:'s3',input:input2,now:()=>T}).catch(error=>({state:'threw',code:error.code}));
 assert.notEqual(out.state,'applied',JSON.stringify(out));
 assert.deepEqual([sourceRows(file2).map(row=>row.value),locRow(file2)],[['Новее'],null],'only the other request\'s row exists; no projection was written under this receipt');
 const pending=rows(file2,'SELECT request_id,state FROM canonical_write_receipt')[0];
 assert.notEqual(pending.state,'applied');
 const later=()=>new Date(Date.parse(T)+86400000).toISOString();
 await reconcileOwnOrigin(env2,{origin:'metadata_sync',operations:MS.metadataSyncRegistry(env2,{intent:[{requestId:pending.request_id,operation:'film_localization_projection',origin:'metadata_sync',event:'s3',target:{kind:'film',id:FID},input:input2}],now:later}),now:later});
 assert.deepEqual(rows(file2,'SELECT state,error_class FROM canonical_write_receipt'),[{state:'abandoned',error_class:'producer_source_changed'}]);
 assert.equal(locRow(file2),null);
}

// ---- 5c. An owner projection is a PROJECTION of the current owner decision: after the decision is removed or changed it is stale, never self-authoritative ----
{
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 await write(env,file,[src('tmdb','Схватка',T1)]);
 const row=dimRow(file,'localization');
 assert.deepEqual([row.status,row.authority,row.source,JSON.parse(row.provenance_json)],['reviewed','owner','owner',{authority:'owner',projection:'owner_review',entries:['tmdb_1656']}],'the materialized row carries the projection marker and the decision it projects');
 // the owner entry CHANGES: the new value replaces the stale projection (not held forever by the strong guard)
 ownerCommit(file,{value:'Жара 2'});
 const changed=await write(env,file,[src('letterboxd','Авто',T2)],{requestId:'req-2'});
 assert.deepEqual([changed.effective.tier,changed.changes,locRow(file).value],['owner',['source:letterboxd','dimension:localization'],'Жара 2']);
 // the owner entry is REMOVED: the projection is stale and not an owner input; a new automatic observation replaces it with the resolver output of the current inputs
 ownerCommit(file,{value:null});
 const removed=await write(env,file,[src('tmdb','Схватка 2',T3)],{requestId:'req-3'});
 assert.deepEqual([removed.held,removed.effective.tier,locRow(file)],[undefined,'automatic',{status:'provisional',source:'letterboxd',value:'Авто',authority:null}]);
 // a removed decision with NO new observation: nothing is written (the stale projection is a handoff to the separate reconciler, AIR-663), the old row is not proven
 const file2=database();seedFilm(file2);addOwner(file2);
 const env2={DB:d1Standin(file2)};
 await write(env2,file2,[src('tmdb','Схватка',T1)]);
 ownerCommit(file2,{value:null});
 const stateOf=async()=>P.filmLocalizationProjectionState(env2,{id:FID,at:T,requestId:'req-1',sources:[src('tmdb','Схватка',T1)],inputs:await P.readProjectionInputs(env2,FID,[src('tmdb','Схватка',T1)])});
 assert.equal((await stateOf()).state,'superseded','the stale projection is not an exact proof of the old request, and no projection-only repair is issued under it');
 assert.equal(locRow(file2).authority,'owner','nothing repaired here: the stale row stays for AIR-663 (identifiable by provenance.projection)');
 // a GENUINE legacy owner row (no marker) keeps its control after the entry is removed: it matches, it is not replaced
 const file3=database();seedFilm(file3);reviewedRow(file3,{value:'Жара',authority:'owner',source:'owner'});
 const kept=await write({DB:d1Standin(file3)},file3,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([kept.effective.tier,kept.changes,locRow(file3).value],['owner',['source:tmdb'],'Жара']);
 // a guarded mismatch stays held, never a match: an independent owner row of another value than the current owner entry
 const file4=database();seedFilm(file4);reviewedRow(file4,{value:'Чужое',authority:'owner',source:'owner'});addOwner(file4);
 assert.equal((await write({DB:d1Standin(file4)},file4,[src('tmdb','x',T1)])).reason,'protected_row_differs');
}

// ---- 5d. Consumers agree with the writer: a marked owner projection is a projection of the current decision in the delivered parity reader AND the derived display resolver ----
{
 const {readDimensionParity}=await load('film-dimension-parity.js');
 const {readFilms}=await load('canonical-read-model.js');
 const parityOf=async(file,id=FID)=>{const result=await readDimensionParity({DB:d1Standin(file)});return result.classified.find(item=>item.film_id===id&&item.dimension==='localization');};
 const titleOf=async(file,id=FID)=>(await readFilms({DB:d1Standin(file)},[id])).items.get(id).title;
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 await write(env,file,[src('tmdb','Схватка',T1)]);
 // materialized and the decision stands: agree (a copy of owner_review_entry), and the derived reader resolves the owner value from the entry
 let row=await parityOf(file);
 assert.deepEqual([row.class,row.reasons],['agree',['owner_projection']]);
 assert.deepEqual([(await titleOf(file)).value,(await titleOf(file)).tier],['Жара','owner']);
 // the decision is REMOVED: the parity reader reports a stale projection (control, kept, NEVER a stale_copy: no retirement eligibility) and the derived reader no longer promotes the old row to owner authority
 ownerCommit(file,{value:null});
 row=await parityOf(file);
 assert.deepEqual([row.class,row.reasons,row.expected],['control',['owner_projection_stale'],{tier:'automatic',source:'tmdb'}]);
 assert.notEqual(row.class,'stale_copy');
 const afterRevocation=await titleOf(file);
 assert.deepEqual([afterRevocation.value,afterRevocation.tier,afterRevocation.source],['Схватка','automatic','tmdb'],'the derived resolver reads the sources, not the stale row, once the entry is gone');
 // the decision CHANGES: stale as well, resolved to the new owner value
 ownerCommit(file,{value:'x'});
 const file2=database();seedFilm(file2);addOwner(file2);
 await write({DB:d1Standin(file2)},file2,[src('tmdb','Схватка',T1)]);
 ownerCommit(file2,{value:'Жара 2'});
 row=await parityOf(file2);
 assert.deepEqual([row.class,row.reasons,row.expected.tier],['control',['owner_projection_stale'],'owner']);
 assert.equal((await titleOf(file2)).value,'Жара 2');
 // owner evidence UNAVAILABLE is never a proved revocation: unproved (control), and the reader without owner evidence keeps reading the marked row as before
 const file3=database({owner:'r2'});seedFilm(file3);
 reviewedRow(file3,{value:'Жара',authority:'owner',source:'owner'});
 exec(file3,"UPDATE film_dimension SET provenance_json='{\"authority\":\"owner\",\"projection\":\"owner_review\"}' WHERE film_id="+q(FID)+" AND dimension='localization'");
 row=await parityOf(file3);
 assert.deepEqual([row.class,row.reasons,row.proof],['control',['owner_projection_unproved'],'unavailable']);
 const bare=(await loadLocalizationInputs({DB:d1Standin(file3)},'film',[FID])).get(FID);
 assert.deepEqual(bare.owner,{value:'Жара',at:T},'no owner evidence read: the marked row is still an owner input');
 const read=(await loadLocalizationInputs({DB:d1Standin(file3)},'film',[FID],{ownerRead:true})).get(FID);
 assert.equal(read.owner,null,'owner evidence read by the caller: the marked row is not an input');
 // an UNMARKED legacy owner row keeps its control after the entry is gone: owner_applied, and the derived reader still resolves it as the owner
 const file4=database();seedFilm(file4);reviewedRow(file4,{value:'Жара',authority:'owner',source:'owner'});
 row=await parityOf(file4);
 assert.deepEqual([row.class,row.reasons],['control',['owner_applied']]);
 assert.deepEqual([(await titleOf(file4)).value,(await titleOf(file4)).tier],['Жара','owner']);
}

// ---- 5e. A legacy provisional candidate with NO source row is a resolver input: a write that replaces the row records it first, or holds ----
{
 const legacyRow=(f,{source='epg',value='Эфир',version='v1',at=T,provenance='NULL'}={})=>exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','provisional',"+q(source)+","+q(version)+","+provenance+","+q(value)+",NULL,0,'none',"+q(at)+")");
 // (a) an incoming higher-ranked source replaces the projection: the legacy candidate is recorded as a source row in the SAME batch, the resolver input unchanged
 const file=database();seedFilm(file);legacyRow(file,{provenance:"'{\"sources\":[\"x\"]}'"});
 const env={DB:d1Standin(file)};
 const out=await write(env,file,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([out.written,out.changes],[true,['source:epg:preserved','source:tmdb','dimension:localization']]);
 assert.deepEqual(rows(file,"SELECT source,value,source_version,provenance_json,observed_at FROM film_localization_source WHERE film_id="+q(FID)+" ORDER BY source"),[{source:'epg',value:'Эфир',source_version:'v1',provenance_json:'{"sources":["x"]}',observed_at:T},{source:'tmdb',value:'Схватка',source_version:'v1',provenance_json:'null',observed_at:T1}]);
 assert.equal(locRow(file).source,'tmdb');
 // (b) sequential: an owner decision materializes over the legacy row, is later revoked, and a LOWER-ranked observation arrives: the preserved legacy candidate is decisive, not lost
 const file2=database();seedFilm(file2);legacyRow(file2);addOwner(file2);
 const env2={DB:d1Standin(file2)};
 const owned=await write(env2,file2,[src('discovery','Скаут',T1)]);
 assert.deepEqual([owned.effective.tier,owned.changes],['owner',['source:epg:preserved','source:discovery','dimension:localization']]);
 assert.equal(locRow(file2).authority,'owner');
 ownerCommit(file2,{value:null});
 const revoked=await write(env2,file2,[src('discovery','Скаут 2',T2)],{requestId:'req-2'});
 assert.deepEqual([revoked.effective.value,revoked.effective.source,locRow(file2).source],['Эфир','epg','epg'],'epg outranks discovery: the legacy candidate decides, durable in its source row');
 // (c) a candidate that cannot be recorded losslessly (no version, an unparseable clock) HOLDS: nothing is written, nothing is lost
 for(const [label,over] of [['no version',{version:''}],['unparseable clock',{at:'yesterday'}]]){
  const f=database();seedFilm(f);legacyRow(f,over);addOwner(f);
  const e={DB:d1Standin(f)};
  const held=await write(e,f,[src('tmdb','Схватка',T1)]).catch(error=>({error:error.code}));
  assert.deepEqual([held.held,held.reason,sourceRows(f),locRow(f).source,e.DB.calls.batches],[true,'legacy_candidate_not_preservable',[],over.at?'epg':'epg',0],label);
 }
 // (d) the legacy candidate that WINS is not replaced (the row matches the resolver output): nothing to preserve, only the source is written
 const file5=database();seedFilm(file5);legacyRow(file5,{source:'letterboxd',value:'Автор'});
 const win=await write({DB:d1Standin(file5)},file5,[src('discovery','Скаут',T1)]);
 assert.deepEqual([win.changes,locRow(file5).source],[['source:discovery'],'letterboxd']);
}

// ---- 6. C1-1 (ADR 0220): a ranked title write creates the minimal identity row as a titleSource CARRIER with the neutral status `unresolved`, under the same CAS; no verdict is computed ----
{
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const input={id:FID,at:T,requestId:'t-1',film:{contractVersion:1,originalTitle:'Heat',source:'tmdb'}};
 await assert.rejects(()=>W.writeFilmFacts(env,{...input,expectedRevision:5}),code('film_person_revision_conflict'));
 assert.equal(dimRow(file,'identity'),null,'a lost CAS creates no row');
 const out=await W.writeFilmFacts(env,{...input,expectedRevision:0});
 assert.ok(out.changes.includes('dimension:identity')&&out.changes.includes('titleSource'),JSON.stringify(out));
 assert.ok(!out.skipped.some(item=>item.reason==='no_identity_row'),'the rank is no longer dropped');
 const row=dimRow(file,'identity');
 assert.deepEqual([row.status,row.authority,row.value,JSON.parse(row.provenance_json)],['unresolved',null,null,{titleSource:{source:'tmdb',at:T}}],'a carrier: neutral status, titleSource only, no authority, no value');
 assert.equal(one(file,"SELECT original_title FROM film WHERE id="+q(FID)),'Heat');
 // replay: nothing left to write; a lower source cannot overwrite the now-ranked title
 assert.equal(await W.filmFactsPresent(env,input),true);
 const lower=await W.writeFilmFacts(env,{...input,requestId:'t-2',expectedRevision:revision(file),film:{contractVersion:1,originalTitle:'Heat EPG',source:'epg'}});
 assert.ok(lower.skipped.some(item=>item.reason==='lower_precedence'));
 // NO VERDICT is computed or stored: whatever the claims say (an unsettled tmdb_tv claim, a competing letterboxd claim, a retired movie claim, a clean Film), the carrier status is the same
 // and the writer reads no claim for it (the ADR 0216 read-side resolver stays the sole verdict mechanism)
 const claimSets={
  clean:[],
  competing:[[FID,'letterboxd','28nq',1,0],[OTHER,'letterboxd','28nq',0,1]],
  unsettledTv:[[FID,'tmdb_tv','5050',0,0]],
  retiredMovie:[[FID,'tmdb','1656',0,1]],
 };
 const seen=[];
 for(const [label,claims] of Object.entries(claimSets)){
  const f=database();seedFilm(f);seedFilm(f,OTHER,'9999');
  for(const [film,scheme,value,trusted,conflicting] of claims){
   if(scheme==='tmdb')exec(f,"UPDATE film_external_id SET trusted="+trusted+",conflicting="+conflicting+" WHERE film_id="+q(film)+" AND scheme='tmdb'");
   else exec(f,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(film)+","+q(scheme)+","+q(value)+","+trusted+","+conflicting+",NULL)");
  }
  const queries=[];
  const e={DB:d1Standin(f,{onQuery:async text=>{queries.push(text);}})};
  await W.writeFilmFacts(e,{...input,expectedRevision:0});
  seen.push([label,dimRow(f,'identity').status]);
  assert.ok(!queries.some(text=>/film_external_id/.test(text)&&/INSERT INTO film_dimension|SELECT\s+\?/.test(text)),label+': the carrier insert reads no claim');
 }
 assert.deepEqual(seen.map(item=>item[1]),['unresolved','unresolved','unresolved','unresolved'],JSON.stringify(seen));
 // compatibility: the status is in the vocabularies of the AIR-660 parity classifier and the existing identity readers, and the row classifies as CONTROL (titleSource), never stale_copy or unknown_legacy
 const {KNOWN_STATUSES,classifyRow}=await load('domain/film-dimension-parity.js');
 assert.ok(KNOWN_STATUSES.identity.includes('unresolved'));
 const carrierFile=database();seedFilm(carrierFile);
 await W.writeFilmFacts({DB:d1Standin(carrierFile)},{...input,expectedRevision:0});
 const carrier=rows(carrierFile,"SELECT * FROM film_dimension WHERE dimension='identity' AND film_id="+q(FID))[0];
 const verdicts=[{verdict:'found'},{verdict:'conflict'},{verdict:'unavailable'}];
 for(const identity of verdicts){
  const out=classifyRow(carrier,{identity,metadata:{status:'unknown'},localization:{status:'unknown',resolved:null},prediction:{fingerprint:{status:'unknown'},prediction:{status:'unknown'}}});
  assert.equal(out.class,'control',identity.verdict+': a titleSource carrier is control whatever the derived verdict is');
 }
 // an unranked source fills an empty title but creates no row (it ranks nothing)
 const file3=database();seedFilm(file3);
 const env3={DB:d1Standin(file3)};
 await W.writeFilmFacts(env3,{...input,expectedRevision:0,film:{contractVersion:1,originalTitle:'Heat',source:'mystery'}});
 assert.deepEqual([one(file3,"SELECT original_title FROM film WHERE id="+q(FID)),dimRow(file3,'identity')],['Heat',null]);
 // the dictionary producer now hands the title over without an identity row, and the writer creates the row
 const D=await load('canonical-dictionary-producer.js');
 const file4=database();seedFilm(file4);
 const env4={DB:d1Standin(file4)};
 const plan=await D.planDictionaryUnits({version:'v1',at:T,entries:[{id:'d1',filmId:FID,tmdbId:'1656',original:'Heat',title:'Схватка',status:'verified'}]});
 const res=await D.applyDictionaryUnits(env4,{plan,now:()=>T});
 assert.deepEqual([res.counts.applied,res.conflicts],[1,[]]);
 assert.deepEqual(JSON.parse(dimRow(file4,'identity').provenance_json),{titleSource:{source:'dictionary',at:T}});
}

// ---- 7. B1: the metadata lock is never created, changed or cleared by W1 outside a review route; a merge with a lock refuses (PV1 owns the release path) ----
{
 const file=database();seedFilm(file);
 exec(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'metadata','reviewed','owner','v','{\"authority\":\"owner\"}',NULL,'owner',0,'none','"+T+"')");
 const locked=dimRow(file,'metadata');
 assert.equal(metadataLocked(locked),true);
 const env={DB:d1Standin(file)};
 const meta=(status,authority=null)=>({dimension:'metadata',status,source:'tmdb',provenance:authority?{authority}:null,updatedAt:T1,attempts:0,nextAction:'none'});
 const out=await W.writeFilmFacts(env,{id:FID,expectedRevision:0,at:T1,requestId:'m-1',film:{contractVersion:1},dimensions:{metadata:meta('fresh')}});
 assert.deepEqual([out.written,out.skipped],[false,[{field:'dimension:metadata',reason:'metadata_locked'}]]);
 const owner=await W.writeFilmFacts(env,{id:FID,expectedRevision:0,at:T1,requestId:'m-2',film:{contractVersion:1},dimensions:{metadata:meta('reviewed','owner')}});
 assert.deepEqual(owner.skipped,[{field:'dimension:metadata',reason:'metadata_locked'}],'even an owner-shaped producer write does not rewrite a lock');
 assert.deepEqual(dimRow(file,'metadata'),locked,'the lock row is byte-identical');
 // a producer cannot CREATE a lock either
 const file2=database();seedFilm(file2);
 const env2={DB:d1Standin(file2)};
 const create=await W.writeFilmFacts(env2,{id:FID,expectedRevision:0,at:T1,requestId:'m-3',film:{contractVersion:1},dimensions:{metadata:meta('reviewed','dictionary')}});
 assert.deepEqual([create.written,create.skipped],[false,[{field:'dimension:metadata',reason:'metadata_lock_review_route'}]]);
 assert.equal(dimRow(file2,'metadata'),null);
 // the review route keeps today's owner-over-owner rule; a non-true flag is refused
 const review=await W.writeFilmFacts(env,{id:FID,expectedRevision:0,at:T1,requestId:'m-4',reviewRoute:true,film:{contractVersion:1},dimensions:{metadata:{...meta('reviewed','owner'),source:'owner'}}});
 assert.equal(review.written,true);
 await assert.rejects(()=>W.writeFilmFacts(env,{id:FID,expectedRevision:1,at:T1,requestId:'m-5',reviewRoute:'yes',film:{contractVersion:1}}),code('film_person_invalid'));
 // an unlocked metadata row still follows the existing rules
 const plain=await W.writeFilmFacts(env2,{id:FID,expectedRevision:0,at:T1,requestId:'m-6',film:{contractVersion:1},dimensions:{metadata:meta('fresh')}});
 assert.equal(plain.written,true);
 // W4: a lock on either side refuses the merge before any statement; without a lock the merge proceeds
 for(const side of ['retired','survivor']){
  const f=database();seedFilm(f);seedFilm(f,OTHER,'9999');
  exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(side==='retired'?OTHER:FID)+",'metadata','reviewed',NULL,NULL,NULL,NULL,NULL,0,'none','"+T+"')");
  const e={DB:d1Standin(f)};
  await assert.rejects(()=>mergeFilms(e,{from:OTHER,to:FID,expected:{from:0,to:0},at:T,evidence:{verified:true},resolve:{metadataState:'retired'}}),code('film_person_metadata_locked'));
  assert.equal(e.DB.calls.batches,0,side+': refused before any batch');
  assert.equal(one(f,"SELECT COUNT(*) FROM film_dimension WHERE dimension='metadata'"),1);
 }
 const f=database();seedFilm(f);seedFilm(f,OTHER,'9999');
 exec(f,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(OTHER)+",'metadata','fresh','tmdb',NULL,NULL,NULL,NULL,0,'none','"+T+"')");
 const merged=await mergeFilms({DB:d1Standin(f)},{from:OTHER,to:FID,expected:{from:0,to:0},at:T,evidence:{verified:true}});
 assert.equal(merged.merged,true);
 assert.equal(dimRow(f,'metadata').status,'fresh','an unlocked lone retired row still moves');
}

// ---- 8. Person path unchanged; the metadata_sync producer plans the projection unit for Films only ----
{
 const file=database();seedFilm(file);
 exec(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ("+q(PID)+",'director/michael-mann',1,'"+T+"')");
 const env={DB:d1Standin(file)};
 const film={id:'28nq',tmdbId:'1656',metadataAt:T,peopleLocalizedAt:T,directors:[{id:'director/michael-mann'}],actors:[]};
 const planned=await MS.planMetadataSyncIntent(env,{event:'p',films:[film],titles:{'28nq':{title:'Схватка',status:'provisional',sources:['w']}},people:{'director/michael-mann':{name:'Майкл Манн',original:'Michael Mann'}},now:()=>T});
 const ops=planned.units.map(unit=>unit.operation+':'+unit.target.kind).filter(item=>!item.startsWith('film_metadata')&&!item.startsWith('film_sync'));
 assert.deepEqual(ops.sort(),['film_localization_projection:film','localization_source:person']);
 const out=await MS.applyMetadataSync(env,{event:'p',films:[film],titles:{'28nq':{title:'Схватка',status:'provisional',sources:['w']}},people:{'director/michael-mann':{name:'Майкл Манн',original:'Michael Mann'}},now:()=>T});
 assert.equal(out.state,'complete',JSON.stringify(out));
 assert.equal(one(file,"SELECT COUNT(*) FROM person_dimension"),0,'Person names keep the source-only path');
 assert.equal(locRow(file).value,'Схватка');
 // the owner domain unavailable: the Film unit is a named preflight refusal before any receipt (never a source-only write); Person units still apply
 const file2=database({owner:'r2'});seedFilm(file2);
 exec(file2,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ("+q(PID)+",'director/michael-mann',1,'"+T+"')");
 const out2=await MS.applyMetadataSync({DB:d1Standin(file2)},{event:'p',films:[film],titles:{'28nq':{title:'Схватка',status:'provisional',sources:['w']}},people:{'director/michael-mann':{name:'Майкл Манн',original:'Michael Mann'}},now:()=>T});
 assert.equal(out2.state,'incomplete');
 assert.ok(out2.refusedDetail.some(item=>item.errorClass==='localization_owner_unavailable'&&item.preflight===true),JSON.stringify(out2.refusedDetail));
 assert.ok(!out2.units.some(unit=>unit.kind==='film_localization_projection'));
 assert.equal(one(file2,"SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_localization_projection'"),0);
 assert.equal(one(file2,"SELECT value FROM person_localization_source WHERE person_id="+q(PID)),'Майкл Манн');
 // a HELD projection (conflicting owner values) is a settled, named skip: nothing written, no receipt, not carried
 const file3=database();seedFilm(file3);addOwner(file3);addOwner(file3,{key:'heat-1995',value:'Другая'});
 const out3=await MS.applyMetadataSync({DB:d1Standin(file3)},{event:'h',films:[film],titles:{'28nq':{title:'Схватка',status:'provisional',sources:['w']}},people:{},now:()=>T});
 assert.equal(out3.state,'complete',JSON.stringify(out3));
 const heldUnit=out3.units.find(unit=>unit.kind==='film_localization_projection');
 assert.deepEqual([heldUnit.state,heldUnit.reason,heldUnit.receipted],['skipped','localization_projection_held',false]);
 assert.deepEqual([sourceRows(file3),locRow(file3),out3.intent],[[],null,[]]);
}

// ---- 9. Cost (a measurement, not a gate): rows written by one projection write and by a no-op ----
{
 const file=database();seedFilm(file);
 const stats={read:0,written:0};
 const env={DB:d1Standin(file,{rowStats:stats})};
 await write(env,file,[src('tmdb','Схватка',T1)]);
 const changed=stats.written;
 stats.written=0;
 await write(env,file,[src('tmdb','Схватка',T1)]);
 assert.equal(stats.written,0,'a no-op writes nothing');
 console.log('film-localization-projection: rows written by one changed projection write (source + projection + revision + fence rows):',changed);
}

console.log('film-localization-projection: ok');
