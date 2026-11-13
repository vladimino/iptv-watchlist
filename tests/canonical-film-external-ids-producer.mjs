// AIR-374 P3a `film_external_ids` (ADR 0133; the owner-mandated FIX of the differential exception `external_ids_not_pruned_by_the_planner`): the dormant Film external-id unit (src/canonical-film-external-ids-producer.js), on the sqlite3-CLI D1 stand-in.
// No Worker, R2, D1 or Cloudflare access. Covered: content and digest, the route gate (dormant below open), add and PRUNE inside the owned schemes only, the ids the identity stands on (canonical identity, rated admission), the typed refusals before any
// receipt (identity conflict, collisions, redirect, absent Film), the interleavings in the same fenced batch, the atomic receipt, E5, replay bound to the digest, transient read failures, parity with the projector's replacement for the owned
// schemes, and the static dormancy. FILM_EXT_SRC points the file at a mutant copy of src/; FILM_EXT_TEMPLATE at a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.FILM_EXT_SRC?path.resolve(process.env.FILM_EXT_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-film-external-ids-producer.js');
const {mutateFilm}=await load('canonical-mutations.js');
const {OPERATION_KINDS}=await load('canonical-receipts.js');
const {PRODUCER_WIRING,PRODUCER_OPERATIONS}=await load('canonical-producers.js');
const {applyFilmExternalIds,filmExternalIdsDigest,filmExternalIdsContent,filmExternalIdsOperation,planFilmExternalIds,FILM_EXTERNAL_IDS_OPERATION,FILM_EXTERNAL_IDS_PER_UNIT_MAX,FILM_EXTERNAL_IDS_REFUSALS}=M;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-extids-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.FILM_EXT_TEMPLATE)fs.copyFileSync(process.env.FILM_EXT_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-13T10:00:00.000Z';
const U='2026-11-01T00:00:00.000Z';
const FID=k=>'film:tmdb:'+k;
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
// A Film with a contract version, a canonical identity (default none), a title that must stay, and stored external ids [scheme,value,trusted,conflicting,provenance].
const seedFilm=(file,k,{identity=null,version=2,title='Kept Title',ids=[]}={})=>assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+FID(k)+"',"+version+","+q(identity)+","+q(title)+",'"+U+"');"+ids.map(([scheme,value,trusted=0,conflicting=0,prov=null])=>"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(k)+"',"+q(scheme)+","+q(value)+","+trusted+","+conflicting+","+q(prov)+");").join('')).status,0);
const ext=(file,k=1)=>rows(file,"SELECT scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id='"+FID(k)+"' ORDER BY scheme,value");
const pairs=(file,k=1)=>ext(file,k).map(item=>item.scheme+':'+item.value);
const filmRow=(file,k=1)=>rows(file,"SELECT contract_version,canonical_identity,original_title,updated_at FROM film WHERE id='"+FID(k)+"'")[0];
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_kind,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,operation,created_at');
const revision=(file,id=FID(1))=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")??0);
const TABLES=['film','film_external_id','film_alias','film_person_credit','film_redirect','film_rated_admission','canonical_revision','canonical_write_receipt'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const unit=(over={})=>({id:FID(1),at:T,schemes:['tmdb','imdb'],externalIds:[{scheme:'tmdb',value:'603',trusted:true},{scheme:'imdb',value:'tt2'}],...over});
const OPEN={origin:'epg',event:'epg:run-1',now:()=>T};

// 1. Content and digest: a SET of ids and a SET of owned schemes (sorted), trust normalized, malformed refused, bounded; the id, the schemes and the ids are bound, the write clock is not.
{
 assert.equal(FILM_EXTERNAL_IDS_OPERATION,'film_external_ids');assert.ok(OPERATION_KINDS.includes('film_external_ids'));assert.ok(!OPERATION_KINDS.includes('film_mutation')||OPERATION_KINDS.includes('film_external_ids'));
 const a=await filmExternalIdsDigest(unit()),b=await filmExternalIdsDigest(unit({at:'2031-01-01T00:00:00.000Z',schemes:['imdb','tmdb'],externalIds:[{scheme:'imdb',value:'tt2'},{scheme:'tmdb',value:603,trusted:true}]}));
 assert.equal(a,b,'order, number values and the write clock do not move the digest');
 assert.notEqual(a,await filmExternalIdsDigest(unit({id:FID(2)})),'the target is bound');
 assert.notEqual(a,await filmExternalIdsDigest(unit({schemes:['tmdb','imdb','letterboxd']})),'the owned schemes are bound');
 assert.notEqual(a,await filmExternalIdsDigest(unit({externalIds:[{scheme:'tmdb',value:'603'},{scheme:'imdb',value:'tt2'}]})),'trust is content');
 assert.notEqual(a,await filmExternalIdsDigest(unit({externalIds:[{scheme:'tmdb',value:'603',trusted:true}]})),'the ids are bound');
 assert.deepEqual(filmExternalIdsContent(unit({schemes:['x'],externalIds:[{scheme:'x',value:'1',trusted:true,conflicting:true}]})).externalIds[0],{scheme:'x',value:'1',trusted:false,conflicting:true,provenance:null});
 assert.deepEqual(filmExternalIdsContent(unit()).schemes,['imdb','tmdb']);
 const bad=[{id:'person:x'},{id:'film:'},{id:7},{schemes:[],externalIds:[]},{schemes:['tmdb','tmdb'],externalIds:[]},{schemes:[]},{schemes:'tmdb'},{schemes:undefined},{schemes:['tmdb','tmdb']},{schemes:['TMDB']},{schemes:['']},{schemes:['a b']},{schemes:[1]},{externalIds:'x'},
  {externalIds:[{scheme:'letterboxd',value:'1'}]},{externalIds:[{scheme:'tmdb',value:''}]},{externalIds:[{scheme:'',value:'1'}]},{externalIds:[null]},{externalIds:[{scheme:'tmdb',value:'1'},{scheme:'tmdb',value:1}]}];
 for(const over of bad)assert.throws(()=>filmExternalIdsContent({...unit(),...over}),code('film_person_invalid'),JSON.stringify(over));
 assert.throws(()=>filmExternalIdsContent(null),code('film_person_invalid'));
 const many=count=>Array.from({length:count},(_,i)=>({scheme:'imdb',value:'tt'+i}));
 assert.equal(filmExternalIdsContent(unit({externalIds:many(FILM_EXTERNAL_IDS_PER_UNIT_MAX)})).externalIds.length,FILM_EXTERNAL_IDS_PER_UNIT_MAX);
 assert.throws(()=>filmExternalIdsContent(unit({externalIds:many(FILM_EXTERNAL_IDS_PER_UNIT_MAX+1)})),code('film_person_bounded'));
 // The source set must be an explicitly PRESENT own array: `[]` is an intentional empty set, but a missing, undefined, null or non-array field is a malformed or partial input, never "the source has no ids".
 assert.equal(filmExternalIdsContent(unit({externalIds:[]})).externalIds.length,0,'an explicit empty array is the intentional empty source set');
 {
  const {externalIds:_omitted,...omitted}=unit();
  assert.ok(!Object.hasOwn(omitted,'externalIds'));
  assert.throws(()=>filmExternalIdsContent(omitted),code('film_person_invalid'),'omitted');
  assert.throws(()=>filmExternalIdsContent(unit({externalIds:undefined})),code('film_person_invalid'),'undefined');
  assert.throws(()=>filmExternalIdsContent(unit({externalIds:null})),code('film_person_invalid'),'null');
  assert.throws(()=>filmExternalIdsContent(unit({externalIds:{}})),code('film_person_invalid'),'an object');
  assert.throws(()=>filmExternalIdsContent(Object.assign(Object.create({externalIds:[]}),omitted)),code('film_person_invalid'),'an inherited property is not an own property');
  await assert.rejects(()=>filmExternalIdsDigest(omitted),code('film_person_invalid'));
 }
 assert.ok(FILM_EXTERNAL_IDS_REFUSALS.has('film_person_identity_conflict')&&FILM_EXTERNAL_IDS_REFUSALS.has('identity_collision')&&FILM_EXTERNAL_IDS_REFUSALS.has('film_person_redirect'));
}

// 2. Dormant below open: one marker read and nothing else; held throws, never a fallback.
for(const stage of ['legacy','r2','prepared']){
 const file=database(stage),env=envOf(file);seedFilm(file,1,{ids:[['imdb','tt1']]});
 const before=dump(file);
 assert.deepEqual(await applyFilmExternalIds(env,{...OPEN,input:unit()}),{state:'skipped',reason:'projector_is_writer',receipt:false},stage);
 assert.equal(env.DB.calls.batches,0);assert.equal(dump(file),before);
}
{
 const file=database('held');seedFilm(file,1);
 await assert.rejects(()=>applyFilmExternalIds(envOf(file),{...OPEN,input:unit()}),code('film_person_held'));
 await assert.rejects(()=>applyFilmExternalIds(envOf(file,{onQuery:async()=>{throw new Error('D1_ERROR: boom');}}),{...OPEN,input:unit()}),/boom|film_person/);
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
}

// 3. ADD AND PRUNE inside the owned schemes, in ONE batch with the applied receipt: the id the source dropped is removed, the new one added, an id of ANOTHER scheme (letterboxd) is untouched, the Film's other facts are kept; the second pass is a no-op
// without a receipt; the request id is stable per event, kind, target and digest.
{
 const file=database('open'),env=envOf(file);
 seedFilm(file,1,{identity:'tmdb:603',ids:[['tmdb','603',1,0],['imdb','tt1'],['letterboxd','abc',1,0,'"rated"']]});
 const out=await applyFilmExternalIds(env,{...OPEN,input:unit()});
 assert.equal(out.state,'applied');
 assert.deepEqual(pairs(file),['imdb:tt2','letterboxd:abc','tmdb:603'],'tt1 pruned, tt2 added, the letterboxd id untouched');
 assert.deepEqual(ext(file).find(item=>item.scheme==='letterboxd'),{scheme:'letterboxd',value:'abc',trusted:1,conflicting:0,provenance_json:'"rated"'});
 assert.deepEqual(filmRow(file),{contract_version:2,canonical_identity:'tmdb:603',original_title:'Kept Title',updated_at:T},'identity, title and contract version are kept; updated_at is the write time');
 assert.equal(revision(file),1);
 const [receipt]=receipts(file);
 assert.deepEqual([receipt.operation,receipt.origin,receipt.target_kind,receipt.target_id,receipt.state,receipt.applied_revision],['film_external_ids','epg','film',FID(1),'applied',1]);
 assert.ok(receipt.request_id.startsWith('epg:film_external_ids:'),receipt.request_id);assert.equal(out.requestId,receipt.request_id);
  const again=await applyFilmExternalIds(env,{...OPEN,input:unit()});
 // a second REAL pass on the revised Film is planned and applied at revision 1 (not 0)
 {
  const second=await applyFilmExternalIds(env,{...OPEN,event:'epg:run-9',input:unit({externalIds:[{scheme:'tmdb',value:'603',trusted:true},{scheme:'imdb',value:'tt5'}]})});
  assert.equal(second.state,'applied');assert.deepEqual(pairs(file),['imdb:tt5','letterboxd:abc','tmdb:603']);assert.equal(revision(file),2);
  assert.deepEqual(receipts(file).map(item=>[item.state,item.applied_revision]),[['applied',1],['applied',2]]);
  assert.equal((await applyFilmExternalIds(env,{...OPEN,event:'epg:run-10',input:unit()})).state,'applied','and back, so the no-op checks below see the first state');
 }
 const snapshot2=dump(file);
 assert.deepEqual([again.state,again.receipt,again.requestId],['noop',false,out.requestId]);
 assert.equal(dump(file),snapshot2,'a second pass writes nothing, not even a receipt');
 const otherEvent=await applyFilmExternalIds(env,{...OPEN,event:'epg:run-2',input:unit({at:'2031-01-01T00:00:00.000Z'})});
 assert.equal(otherEvent.state,'noop');assert.notEqual(otherEvent.requestId,out.requestId,'the event is part of the request id');
 assert.equal(dump(file),snapshot2);
}

// 3b. A malformed or PARTIAL input never prunes: with the marker `open` and stored ids in the owned scheme, an input whose `externalIds` is omitted, undefined, null or not an array is refused `film_person_invalid` BEFORE any receipt or batch; the
// stored ids, the Film, the revision and the receipts are unchanged and no batch reached the database. Only an explicit `[]` is the empty source set.
{
 const file=database('open'),env=envOf(file);
 seedFilm(file,1,{identity:'tmdb:603',ids:[['tmdb','603',1,0],['imdb','tt1'],['imdb','tt2'],['letterboxd','abc',1,0]]});
 const before=dump(file);
 const {externalIds:_omitted,...omitted}=unit({schemes:['imdb']});
 for(const [label,input] of [['omitted',omitted],['undefined',unit({schemes:['imdb'],externalIds:undefined})],['null',unit({schemes:['imdb'],externalIds:null})],['a string',unit({schemes:['imdb'],externalIds:'tt1'})],['an object',unit({schemes:['imdb'],externalIds:{}})],['inherited',Object.assign(Object.create({externalIds:[]}),omitted)]]){
  await assert.rejects(()=>applyFilmExternalIds(env,{...OPEN,input}),code('film_person_invalid'),label);
  await assert.rejects(()=>planFilmExternalIds(env,input),code('film_person_invalid'),label+' (plan)');
  assert.equal(dump(file),before,label+': nothing changed');assert.equal(env.DB.calls.batches,0,label+': no batch reached the database');
  assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0,label+': no receipt');assert.deepEqual(pairs(file),['imdb:tt1','imdb:tt2','letterboxd:abc','tmdb:603'],label+': every stored id is still there');
 }
 // the reconcile path treats a re-plan that omits the field as a moved or malformed source, never as an empty one
 const target={kind:'film',id:FID(1)},digest=await filmExternalIdsDigest(unit({schemes:['imdb'],externalIds:[]}));
 const receipt={operation:'film_external_ids',target,contentDigest:digest,requestId:'epg:film_external_ids:x'};
 assert.equal(await filmExternalIdsOperation({replan:async()=>omitted}).revalidate(env,receipt),'stale');
 assert.deepEqual(await filmExternalIdsOperation({replan:async()=>omitted}).readback(env,target,receipt),{disposition:'abandon',errorClass:'producer_source_changed'},'a re-plan without the field has no digest: a typed abandon, never an empty source');
 await assert.rejects(()=>filmExternalIdsOperation({replan:async()=>omitted}).replay(env,receipt,{requestId:receipt.requestId,attempt:2,target,currentRevision:0}),code('film_person_invalid'));
 assert.equal(dump(file),before);assert.equal(env.DB.calls.batches,0);
 // and the intentional empty set still prunes, so the distinction is the whole point
 assert.equal((await applyFilmExternalIds(env,{...OPEN,input:unit({schemes:['imdb'],externalIds:[]})})).state,'applied');
 assert.deepEqual(pairs(file),['letterboxd:abc','tmdb:603']);
}

// 4. An EMPTY source set with owned schemes removes every stored id of those schemes (explicit), and only those; a stored id the source still lists keeps its trust, conflict flag and provenance; a Film with nothing to change is a no-op.
{
 const file=database('open'),env=envOf(file);
 seedFilm(file,1,{ids:[['imdb','tt1'],['imdb','tt9',0,1,'"c"'],['tmdb','5',0,0],['letterboxd','abc',1,0]]});
 const out=await applyFilmExternalIds(env,{...OPEN,input:unit({schemes:['imdb'],externalIds:[]})});
 assert.equal(out.state,'applied');assert.deepEqual(pairs(file),['letterboxd:abc','tmdb:5']);
 const file2=database('open'),env2=envOf(file2);
 seedFilm(file2,1,{ids:[['tmdb','603',1,0,'"owner"'],['imdb','tt2',0,1,'"stored"']]});
 const before=dump(file2);
 const noop=await applyFilmExternalIds(env2,{...OPEN,input:unit({externalIds:[{scheme:'tmdb',value:'603',trusted:false},{scheme:'imdb',value:'tt2',trusted:true,provenance:'other'}]})});
 assert.equal(noop.state,'noop');assert.equal(dump(file2),before,'stored ids are never rewritten, not even by a differing source');
 assert.deepEqual(await planFilmExternalIds(env2,unit({externalIds:[{scheme:'tmdb',value:'603',trusted:true},{scheme:'imdb',value:'tt2'}]})),{absent:false,noop:true,action:'none',revision:0,contractVersion:2,add:[],remove:[]});
}

// 5. The ids the identity stands on are never removed: the canonical identity (`tmdb:<n>`) and the tmdb id of the Film's rated admission. A source that drops or REPLACES one is refused `film_person_identity_conflict` BEFORE any receipt, with nothing written.
{
 const file=database('open'),env=envOf(file);
 seedFilm(file,1,{identity:'tmdb:603',ids:[['tmdb','603',1,0],['imdb','tt1']]});
 const before=dump(file);
 await assert.rejects(()=>applyFilmExternalIds(env,{...OPEN,input:unit({externalIds:[{scheme:'imdb',value:'tt2'}]})}),code('film_person_identity_conflict'));
 await assert.rejects(()=>applyFilmExternalIds(env,{...OPEN,input:unit({externalIds:[{scheme:'tmdb',value:'604',trusted:true},{scheme:'imdb',value:'tt1'}]})}),code('film_person_identity_conflict'),'a replaced identity id');
 assert.equal(dump(file),before);assert.equal(env.DB.calls.batches,0);assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
 // the same Film keeps the id when the source still lists it, whatever else it drops
 assert.equal((await applyFilmExternalIds(env,{...OPEN,input:unit({externalIds:[{scheme:'tmdb',value:'603',trusted:true}]})})).state,'applied');assert.deepEqual(pairs(file),['tmdb:603']);
 // an owned scheme the source does not name leaves the identity id alone
 const file2=database('open'),env2=envOf(file2);
 seedFilm(file2,1,{identity:'tmdb:603',ids:[['tmdb','603',1,0],['imdb','tt1']]});
 assert.equal((await applyFilmExternalIds(env2,{...OPEN,input:unit({schemes:['imdb'],externalIds:[]})})).state,'applied');assert.deepEqual(pairs(file2),['tmdb:603']);
 // the rated admission's tmdb id (a Film without a canonical identity yet)
 const file3=database('open'),env3=envOf(file3);
 seedFilm(file3,1,{ids:[['tmdb','603',1,0],['imdb','tt1']]});
 assert.equal(sqlite(file3,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('"+FID(1)+"','603','abc','"+'a'.repeat(64)+"','t',1999,'k','tmdb_603','"+U+"','r','"+U+"')").status,0);
 await assert.rejects(()=>applyFilmExternalIds(env3,{...OPEN,input:unit({externalIds:[{scheme:'imdb',value:'tt2'}]})}),code('film_person_identity_conflict'));
 assert.deepEqual(pairs(file3),['imdb:tt1','tmdb:603']);assert.equal(one(file3,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
}

// 6. Other refusals BEFORE any receipt: a trusted id owned by ANOTHER Film (identity_collision), two trusted values of one scheme for the Film (identity_collision), a redirected Film (film_person_redirect), an invalid unit; an ABSENT Film is `absent` and nothing is created.
{
 const file=database('open'),env=envOf(file);
 seedFilm(file,1,{ids:[['imdb','tt1']]});seedFilm(file,2,{ids:[['imdb','tt7',1,0]]});
 await assert.rejects(()=>applyFilmExternalIds(env,{...OPEN,input:unit({externalIds:[{scheme:'imdb',value:'tt7',trusted:true}]})}),code('identity_collision'));
 await assert.rejects(()=>applyFilmExternalIds(env,{...OPEN,input:unit({externalIds:[{scheme:'imdb',value:'tt8',trusted:true},{scheme:'imdb',value:'tt9',trusted:true}]})}),code('identity_collision'),'two trusted values of one scheme');
 assert.equal(env.DB.calls.batches,0,'a collision is refused by the pre-plan, before any batch');assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0,'and before any receipt');assert.deepEqual(pairs(file),['imdb:tt1']);
 // an untrusted or conflicting twin of another Film's id is allowed (the partial unique index only covers trusted, non-conflicting ids)
 assert.equal((await applyFilmExternalIds(env,{...OPEN,input:unit({externalIds:[{scheme:'imdb',value:'tt7'}]})})).state,'applied');assert.deepEqual(pairs(file),['imdb:tt7']);
 // replacing the Film's own trusted id by a new trusted one of the same scheme in ONE pass is fine (the old one leaves in the same batch)
 const file2=database('open'),env2=envOf(file2);seedFilm(file2,1,{ids:[['imdb','tt1',1,0]]});
 assert.equal((await applyFilmExternalIds(env2,{...OPEN,input:unit({externalIds:[{scheme:'imdb',value:'tt2',trusted:true}]})})).state,'applied');assert.deepEqual(ext(file2).map(i=>[i.scheme,i.value,i.trusted]),[['imdb','tt2',1]]);
 // a plan over the unit bound (many stored ids dropped at once) is refused before any batch
 {
  const file5=database('open'),env5=envOf(file5);
  seedFilm(file5,1,{ids:Array.from({length:FILM_EXTERNAL_IDS_PER_UNIT_MAX+1},(_,i)=>['imdb','tt'+i])});
  await assert.rejects(()=>applyFilmExternalIds(env5,{...OPEN,input:unit({schemes:['imdb'],externalIds:[]})}),code('film_person_bounded'));
  assert.equal(env5.DB.calls.batches,0);assert.equal(one(file5,'SELECT COUNT(*) FROM film_external_id'),FILM_EXTERNAL_IDS_PER_UNIT_MAX+1);
 }
 // redirect
 const file3=database('open'),env3=envOf(file3);seedFilm(file3,1,{ids:[['imdb','tt1']]});seedFilm(file3,2);
 assert.equal(sqlite(file3,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FID(1)+"','"+FID(2)+"','"+U+"')").status,0);
 const before=dump(file3);
 await assert.rejects(()=>applyFilmExternalIds(env3,{...OPEN,input:unit()}),code('film_person_redirect'));assert.equal(dump(file3),before);
 await assert.rejects(()=>applyFilmExternalIds(env3,{...OPEN,input:unit({schemes:[]})}),code('film_person_invalid'));
 // absent
 const file4=database('open'),env4=envOf(file4);
 const out=await applyFilmExternalIds(env4,{...OPEN,input:unit()});
 assert.deepEqual([out.state,out.receipt],['absent',false]);assert.equal(one(file4,'SELECT COUNT(*) FROM film'),0);assert.equal(env4.DB.calls.batches,0);assert.equal(one(file4,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
 assert.deepEqual(await planFilmExternalIds(env4,unit()),{absent:true,noop:false,action:'none',revision:0,add:[],remove:[]});
}

// 7. Interleavings in the SAME fenced batch: a Film that VANISHES between the fresh read and the batch is never recreated (requireExisting, film_person_precondition, the receipt failed); a stale revision is a retryable conflict, rolled back whole.
{
 const file=database('open');seedFilm(file,1,{ids:[['imdb','tt1']]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"DELETE FROM film_external_id WHERE film_id='"+FID(1)+"';DELETE FROM film WHERE id='"+FID(1)+"'").status,0);}});
 await assert.rejects(()=>applyFilmExternalIds(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),0,'a vanished Film is not recreated');assert.equal(receipts(file)[0].state,'failed');
 const file1=database('open');seedFilm(file1,1,{ids:[['imdb','tt1']]});
 let first=0;
 const gone=envOf(file1,{onBatch:async()=>{first++;if(first===1)assert.equal(sqlite(file1,"DELETE FROM film_external_id WHERE film_id='"+FID(1)+"';DELETE FROM film WHERE id='"+FID(1)+"'").status,0);}});
 await assert.rejects(()=>applyFilmExternalIds(gone,{...OPEN,input:unit()}),code('film_person_reference'),'gone before the fresh read of the write');assert.equal(one(file1,'SELECT COUNT(*) FROM film'),0);
 const file2=database('open');seedFilm(file2,1,{ids:[['imdb','tt1']]});
 let step=0;
 const moved=envOf(file2,{onBatch:async()=>{step++;if(step===1)await mutateFilm(envOf(file2),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2,aliases:[{kind:'title',value:'Other'}]}});}});
 await assert.rejects(()=>applyFilmExternalIds(moved,{...OPEN,input:unit()}),code('film_person_revision_conflict'));
 assert.deepEqual(pairs(file2),['imdb:tt1'],'nothing of the unit was written');assert.notEqual(receipts(file2)[0].state,'applied');
}

// 8. The atomic receipt: a receipt that no longer matches this attempt rolls the WHOLE batch back (the removals and additions included).
{
 const file=database('open');seedFilm(file,1,{ids:[['imdb','tt1']]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET attempts=attempts+1").status,0);}});
 await assert.rejects(()=>applyFilmExternalIds(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.deepEqual(pairs(file),['imdb:tt1'],'neither the prune nor the additions survive');assert.equal(revision(file),0);assert.notEqual(receipts(file)[0].state,'applied');
}

// 9. E5: the same ids stored by another writer between the pre-plan and the fenced write leave nothing to write: the receipt ends `unknown` (never a second marking batch, never applied by guess).
{
 const file=database('open');seedFilm(file,1,{ids:[['imdb','tt1']]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===1)await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2,removeExternalIds:[{scheme:'imdb',value:'tt1'}],externalIds:[{scheme:'tmdb',value:'603',trusted:true},{scheme:'imdb',value:'tt2'}]}});}});
 const out=await applyFilmExternalIds(racing,{...OPEN,input:unit()});
 assert.equal(out.state,'unknown');assert.deepEqual(pairs(file),['imdb:tt2','tmdb:603']);assert.equal(revision(file),1,'only the interloper wrote');
 assert.equal(receipts(file).length,1);assert.equal(racing.DB.calls.batches,2,'the interloper and the pending mark; no second marking batch');
}

// 10. Replay bound to the digest: the spec re-plans from the producer's own source; a moved source is a typed abandon, a missing re-plan is refused; a content refusal is `stale`, a read failure propagates (the receipt stays due).
{
 const file=database('open');seedFilm(file,1,{identity:'tmdb:603',ids:[['tmdb','603',1,0],['imdb','tt1']]});
 const env=envOf(file),input=unit();
 const digest=await filmExternalIdsDigest(input);
 const target={kind:'film',id:FID(1)};
 const receipt={operation:'film_external_ids',target,contentDigest:digest,requestId:await (await load('canonical-producer-adapters.js')).producerRequestId({origin:'epg',operation:'film_external_ids',event:'epg:run-1',target,digest})};
 const ctx={requestId:receipt.requestId,attempt:2,target,currentRevision:0};
 const moved={...input,externalIds:[{scheme:'tmdb',value:'603',trusted:true},{scheme:'imdb',value:'tt3'}]};
 await assert.rejects(()=>filmExternalIdsOperation({replan:async()=>moved}).replay(env,receipt,ctx),code('film_person_invalid'));
 await assert.rejects(()=>filmExternalIdsOperation({replan:async()=>null}).replay(env,receipt,ctx),code('producer_replan_unavailable'));
 await assert.rejects(()=>filmExternalIdsOperation({replan:async()=>{throw new Error('x');}}).replay(env,receipt,ctx),code('producer_replan_unavailable'));
 assert.throws(()=>filmExternalIdsOperation({}),code('film_person_invalid'));
 assert.deepEqual(await filmExternalIdsOperation({replan:async()=>moved}).readback(env,target,receipt),{disposition:'abandon',errorClass:'producer_source_changed'});
 assert.equal(await filmExternalIdsOperation({replan:async()=>null}).revalidate(env,receipt),'stale');
 assert.equal(await filmExternalIdsOperation({replan:async()=>moved}).revalidate(env,receipt),'stale','a moved source');
 assert.equal(await filmExternalIdsOperation({replan:async()=>input}).revalidate(env,receipt),'proceed');
 assert.deepEqual(await filmExternalIdsOperation({replan:async()=>input}).readback(env,target,receipt),{digest:null,revision:0});
 // a replay with no pending receipt row is refused by the fenced receipt tail (nothing is written)
 await assert.rejects(()=>filmExternalIdsOperation({replan:async()=>input}).replay(env,receipt,ctx),code('film_person_precondition'));assert.deepEqual(pairs(file),['imdb:tt1','tmdb:603']);
 // a content refusal on the re-plan (the source drops the identity id) is stale, not a transport failure
 const dropIdentity={...input,externalIds:[{scheme:'imdb',value:'tt2'}]},dropReceipt={...receipt,contentDigest:await filmExternalIdsDigest(dropIdentity)};
 assert.equal(await filmExternalIdsOperation({replan:async()=>dropIdentity}).revalidate(env,dropReceipt),'stale','an identity refusal is a content refusal');
 await assert.rejects(()=>filmExternalIdsOperation({replan:async()=>input}).revalidate(envOf(file,{onQuery:async()=>{throw new Error('D1_ERROR: boom');}}),receipt),/boom/);
 // an absent Film is superseded, never created
 const gone={...input,id:FID(77)},goneReceipt={...receipt,target:{kind:'film',id:FID(77)},contentDigest:await filmExternalIdsDigest(gone)};
 assert.equal(await filmExternalIdsOperation({replan:async()=>gone}).revalidate(env,goneReceipt),'superseded');
}

// 10b. End to end: a first attempt that fails in the batch leaves a due receipt; the bounded own-origin reconcile re-plans from the producer's own source, replays it and ends in the same rows as a first pass (the prune included); a receipt of another
// origin is never touched.
{
 const {reconcileOwnOrigin}=await load('canonical-producer-adapters.js');
 const file=database('open');seedFilm(file,1,{identity:'tmdb:603',ids:[['tmdb','603',1,0],['imdb','tt1'],['letterboxd','abc',1,0]]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET attempts=attempts+1").status,0);}});
 await assert.rejects(()=>applyFilmExternalIds(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.deepEqual(pairs(file),['imdb:tt1','letterboxd:abc','tmdb:603']);assert.notEqual(receipts(file)[0].state,'applied');
 const later=()=>new Date(Date.parse(T)+3600000).toISOString();
 const other=await reconcileOwnOrigin(envOf(file),{origin:'discovery',operations:new Map([[FILM_EXTERNAL_IDS_OPERATION,filmExternalIdsOperation({replan:async()=>unit(),now:later})]]),now:later});
 assert.equal(other.considered,0,'another origin has no due receipt');assert.deepEqual(pairs(file),['imdb:tt1','letterboxd:abc','tmdb:603']);
 const out=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:new Map([[FILM_EXTERNAL_IDS_OPERATION,filmExternalIdsOperation({replan:async()=>unit(),now:later})]]),now:later});
 assert.equal(out.considered,1);assert.deepEqual(pairs(file),['imdb:tt2','letterboxd:abc','tmdb:603'],'the replay pruned tt1 and added tt2, the letterboxd id untouched');
 assert.equal(receipts(file)[0].state,'applied');
 {
  const target={kind:'film',id:FID(1)},digest=await filmExternalIdsDigest(unit()),rc={operation:'film_external_ids',target,contentDigest:digest,requestId:receipts(file)[0].request_id};
  assert.deepEqual(await filmExternalIdsOperation({replan:async()=>unit()}).readback(envOf(file),target,rc),{digest,revision:1},'the stored facts are read back as present');
  assert.equal(await filmExternalIdsOperation({replan:async()=>unit()}).revalidate(envOf(file),rc),'superseded');
 }
 // a source that moved on is abandoned, never replayed
 const file2=database('open');seedFilm(file2,1,{ids:[['imdb','tt1']]});
 let n2=0;
 const racing2=envOf(file2,{onBatch:async()=>{n2++;if(n2===2)assert.equal(sqlite(file2,"UPDATE canonical_write_receipt SET attempts=attempts+1").status,0);}});
 await assert.rejects(()=>applyFilmExternalIds(racing2,{...OPEN,input:unit()}),code('film_person_precondition'));
 await reconcileOwnOrigin(envOf(file2),{origin:'epg',operations:new Map([[FILM_EXTERNAL_IDS_OPERATION,filmExternalIdsOperation({replan:async()=>unit({externalIds:[{scheme:'imdb',value:'tt9'}]}),now:later})]]),now:later});
 assert.deepEqual(pairs(file2),['imdb:tt1'],'a moved source is not replayed');assert.notEqual(receipts(file2)[0].state,'applied');
}

// 11. Transient D1 read failures propagate: nothing is written and no receipt is created by a failed plan.
{
 const file=database('open');seedFilm(file,1,{ids:[['imdb','tt1']]});
 const failing=envOf(file,{onQuery:async sql=>{if(/film_external_id/i.test(String(sql)))throw new Error('D1_ERROR: boom');}});
 await assert.rejects(()=>applyFilmExternalIds(failing,{...OPEN,input:unit()}),/boom|film_person/);
 assert.deepEqual(pairs(file),['imdb:tt1']);assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
 assert.equal((await applyFilmExternalIds(envOf(file),{...OPEN,input:unit()})).state,'applied','a later pass settles it');
}

// 12. Parity with the projector's replacement: for the owned schemes the stored set after the unit equals the source set, which is what the projector's full replacement produced (the difference of the exception `external_ids_not_pruned_by_the_planner`
// is the unit's job to remove); ids of schemes the source does not own are the one deliberate difference.
{
 const file=database('open'),env=envOf(file);
 seedFilm(file,1,{ids:[['tmdb','603',1,0],['imdb','tt1'],['imdb','tt3'],['tmdb_tv','9']]});
 const source=[{scheme:'tmdb',value:'603',trusted:true},{scheme:'imdb',value:'tt2'}];
 await applyFilmExternalIds(env,{...OPEN,input:unit({schemes:['tmdb','imdb'],externalIds:source})});
 assert.deepEqual(ext(file).filter(item=>['tmdb','imdb'].includes(item.scheme)).map(item=>item.scheme+':'+item.value),source.map(item=>item.scheme+':'+item.value).sort(),'the owned schemes equal the source set');
 assert.deepEqual(ext(file).filter(item=>item.scheme==='tmdb_tv').map(item=>item.value),['9'],'a scheme the source does not own is kept');
}

// 13. Static: dormant. Nothing in src, build.mjs or the Worker imports the module; no network, timer, cron or R2 API; no write SQL of its own (the writer is mutateFilm); the kind is closed and not wired into PRODUCER_OPERATIONS.
{
 const text=fs.readFileSync('src/canonical-film-external-ids-producer.js','utf8');
 const code_=text.split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
 assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s/i.test(code_.replace(/SELECT[^'`"]*/g,'')),'no write SQL of its own');
 for(const word of ['fetch(','setTimeout','setInterval','env.BUCKET','R2','cron','waitUntil'])assert.ok(!code_.includes(word),word);
 for(const file of fs.readdirSync('src').filter(name=>name.endsWith('.js')&&name!=='canonical-film-external-ids-producer.js'))assert.ok(!fs.readFileSync('src/'+file,'utf8').includes('canonical-film-external-ids-producer'),file+' does not import the unit');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('canonical-film-external-ids-producer'),'not bundled');
 assert.equal(PRODUCER_OPERATIONS.size,0,'no operation is registered: readiness stays truthful');
 assert.ok(PRODUCER_WIRING.every(item=>!item.requires.includes('film_external_ids')),'PRODUCER_WIRING is unchanged: wiring belongs to the producer wiring PR');
}
console.log('canonical-film-external-ids-producer ok');
process.exit(0);
