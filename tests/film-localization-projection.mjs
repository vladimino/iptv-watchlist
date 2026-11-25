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
const write=(env,file,sources,{requestId='req-1',at=T,expectedRevision}={})=>P.writeFilmLocalizationProjection(env,{id:FID,expectedRevision:expectedRevision??revision(file),at,requestId,sources});
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
 assert.deepEqual([stale.written,stale.skipped],[false,[{field:'source:tmdb',reason:'stale'}]]);
 assert.deepEqual(sourceRows(file),[{source:'tmdb',value:'A',observed_at:T2}]);
 // no-op projection: a newer observation of the same value rewrites only the source row (the projection row's clock follows the effective observation)
 const plan=P.planFilmLocalizationProjection(await W.readFilmSnapshot(env,FID),await P.readOwnerReviewToken(env,FID),{id:FID,at:T,requestId:'req-x',sources:[src('epg','Other',T3)]});
 assert.deepEqual(plan.changes,['source:epg'],'the resolver output equals the stored row: no projection statement');
 assert.equal(plan.statements.filter(([sql])=>sql.startsWith('INSERT INTO film_dimension')).length,0);
}

// ---- 3. Owner and reviewed overlay: a lower tier never replaces a higher one ----
{
 const file=database();seedFilm(file);addOwner(file);
 const env={DB:d1Standin(file)};
 const out=await write(env,file,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([out.written,out.effective.tier,out.skipped],[true,'owner',[{field:'localization',reason:'owner_kept'}]]);
 assert.equal(locRow(file),null,'no automatic projection is written over a verified owner value');
 assert.deepEqual(sourceRows(file).map(row=>row.source),['tmdb'],'the source row is still recorded');
 // a reviewed dictionary row is kept and never replaced
 const file2=database();seedFilm(file2);
 exec(file2,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','reviewed','dictionary','verified','{\"authority\":\"dictionary\"}','Словарь','dictionary',0,'keep_reviewed','"+T+"')");
 const env2={DB:d1Standin(file2)};
 const kept=await write(env2,file2,[src('letterboxd','Авто',T1)]);
 assert.deepEqual([kept.effective.tier,kept.skipped],['reviewed',[{field:'localization',reason:'reviewed_kept'}]]);
 assert.deepEqual(locRow(file2),{status:'reviewed',source:'dictionary',value:'Словарь',authority:'dictionary'});
 // a reviewed row without a value is still strong(): the automatic tier wins the resolver but the row is never replaced
 const file5=database();seedFilm(file5);
 exec(file5,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','reviewed','dictionary','verified',NULL,NULL,'dictionary',0,'keep_reviewed','"+T+"')");
 const env5={DB:d1Standin(file5)};
 const blankReviewed=await write(env5,file5,[src('tmdb','Авто',T1)]);
 assert.deepEqual([blankReviewed.changes,blankReviewed.skipped],[['source:tmdb'],[{field:'localization',reason:'reviewed_kept'}]]);
 assert.deepEqual(locRow(file5),{status:'reviewed',source:'dictionary',value:null,authority:'dictionary'});
 // owner value of a retired id that redirects to the Film counts (owner_review_entry links are snapshots a merge does not rewrite)
 const file3=database();seedFilm(file3);
 exec(file3,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old-1',"+q(FID)+",'"+T+"')");
 addOwner(file3,{key:'old-1',link:'film:old-1',value:'Старая жара'});
 const env3={DB:d1Standin(file3)};
 assert.equal((await write(env3,file3,[src('tmdb','Схватка',T1)])).effective.tier,'owner');
 assert.equal(locRow(file3),null);
 // two different verified owner values: owner_conflict, no projection
 const file4=database();seedFilm(file4);addOwner(file4);addOwner(file4,{key:'heat-1995',value:'Другая'});
 const env4={DB:d1Standin(file4)};
 const conflict=await write(env4,file4,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([conflict.effective.tier,conflict.skipped],['owner_conflict',[{field:'localization',reason:'owner_conflict'}]]);
 assert.equal(locRow(file4),null);
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
 assert.equal(locRow(file2),null);
 // (c) a concurrent dictionary review (W1, the Film revision moves): the revision CAS refuses; the replan keeps the reviewed row
 const file3=database();seedFilm(file3);
 let fire3=true;
 const env3={DB:d1Standin(file3,{onBatch:async statements=>{if(fire3&&statements.some(item=>/film_localization_source/.test(item.text))){fire3=false;exec(file3,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','reviewed','dictionary','verified','{\"authority\":\"dictionary\"}','Словарь','dictionary',0,'keep_reviewed','"+T+"');INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(FID)+",1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1;");}}})};
 await assert.rejects(()=>write(env3,file3,[src('tmdb','Схватка',T1)],{expectedRevision:0}),code('film_person_revision_conflict'));
 const after=await write(env3,file3,[src('tmdb','Схватка',T1)]);
 assert.deepEqual([after.skipped,locRow(file3).value],[[{field:'localization',reason:'reviewed_kept'}],'Словарь']);
 // (d) the owner domain is not D1-authoritative: refused before any batch
 const file4=database({owner:'r2'});seedFilm(file4);
 const env4={DB:d1Standin(file4)};
 await assert.rejects(()=>write(env4,file4,[src('tmdb','Схватка',T1)]),code('localization_owner_unavailable'));
 assert.equal(env4.DB.calls.batches,0);
 // (e) never a redirect, never a Film creation
 const file5=database();
 const env5={DB:d1Standin(file5)};
 await assert.rejects(()=>P.writeFilmLocalizationProjection(env5,{id:FID,expectedRevision:0,at:T,requestId:'r',sources:[src('tmdb','X',T1)]}),code('film_person_precondition'));
 assert.equal(env5.DB.calls.batches,0,'an absent Film is refused before any batch');
 seedFilm(file5);seedFilm(file5,OTHER,'9999');exec(file5,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(OTHER)+","+q(FID)+",'"+T+"')");
 await assert.rejects(()=>P.writeFilmLocalizationProjection(env5,{id:OTHER,expectedRevision:0,at:T,requestId:'r',sources:[src('tmdb','X',T1)]}),code('film_person_redirect'));
}

// ---- 5. The receipt kind: new digest, readback proves source AND projection, historical receipts stay terminal, an unsettled old receipt settles by the old rules ----
{
 const file=database();seedFilm(file);
 const env={DB:d1Standin(file)};
 const input={id:FID,at:T,sources:[src('wikidata','Схватка',T1)]};
 const out=await MS.applyFilmLocalizationProjection(env,{origin:'metadata_sync',event:'e1',input,now:()=>T});
 assert.equal(out.state,'applied');
 assert.deepEqual(rows(file,"SELECT operation,state FROM canonical_write_receipt"),[{operation:'film_localization_projection',state:'applied'}]);
 assert.equal(locRow(file).value,'Схватка');
 // the readback proves both: removing the projection row makes the proof fail although the source row is still there
 const op=MS.filmLocalizationProjectionOperation({replan:async()=>input});
 const receipt={requestId:out.requestId,contentDigest:await MS.filmProjectionDigest(input),target:{kind:'film',id:FID}};
 assert.equal((await op.readback(env,receipt.target,receipt)).digest,receipt.contentDigest);
 exec(file,"DELETE FROM film_dimension WHERE film_id="+q(FID)+" AND dimension='localization'");
 assert.equal((await op.readback(env,receipt.target,receipt)).digest,null,'a source row alone is no proof of the projection');
 // the digest binds the resolver identity and the kind: the same content under the old kind is another request
 const oldDigest=await MS.localizationDigest(MS.LOCALIZATION_SOURCE_OPERATION,{kind:'film',id:FID,sources:input.sources});
 assert.notEqual(oldDigest,receipt.contentDigest);
 assert.notEqual(await producerRequestId({origin:'metadata_sync',operation:'localization_source',event:'e1',target:{kind:'film',id:FID},digest:oldDigest}),out.requestId);
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

// ---- 6. C1: a ranked title write creates the minimal identity row with titleSource, under the same CAS ----
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
 assert.deepEqual([row.status,row.authority,row.value,JSON.parse(row.provenance_json)],['found',null,null,{titleSource:{source:'tmdb',at:T}}]);
 assert.equal(one(file,"SELECT original_title FROM film WHERE id="+q(FID)),'Heat');
 // replay: nothing left to write; a lower source cannot overwrite the now-ranked title
 assert.equal(await W.filmFactsPresent(env,input),true);
 const lower=await W.writeFilmFacts(env,{...input,requestId:'t-2',expectedRevision:revision(file),film:{contractVersion:1,originalTitle:'Heat EPG',source:'epg'}});
 assert.ok(lower.skipped.some(item=>item.reason==='lower_precedence'));
 // a Film with a competing claim gets the informational verdict `conflict`
 const file2=database();seedFilm(file2);seedFilm(file2,OTHER,'9999');
 exec(file2,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID)+",'letterboxd','28nq',1,0,NULL),("+q(OTHER)+",'letterboxd','28nq',0,1,NULL)");
 const env2={DB:d1Standin(file2)};
 await W.writeFilmFacts(env2,{...input,expectedRevision:0});
 assert.equal(dimRow(file2,'identity').status,'conflict');
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
 // the owner domain unavailable: the Film unit fails before any receipt; Person units still apply
 const file2=database({owner:'r2'});seedFilm(file2);
 exec(file2,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ("+q(PID)+",'director/michael-mann',1,'"+T+"')");
 const out2=await MS.applyMetadataSync({DB:d1Standin(file2)},{event:'p',films:[film],titles:{'28nq':{title:'Схватка',status:'provisional',sources:['w']}},people:{'director/michael-mann':{name:'Майкл Манн',original:'Michael Mann'}},now:()=>T});
 assert.equal(out2.state,'incomplete');
 assert.ok(out2.units.some(unit=>unit.kind==='film_localization_projection'&&unit.errorClass==='localization_owner_unavailable'&&unit.receipted===false));
 assert.equal(one(file2,"SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_localization_projection'"),0);
 assert.equal(one(file2,"SELECT value FROM person_localization_source WHERE person_id="+q(PID)),'Майкл Манн');
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
