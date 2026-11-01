// ADR 0081. Owner reviews stay on R2 until migration 0009 is applied and the marker
// is switched. The switch is not part of this test. No production database is opened.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {activateOwnerReviews,applyViewOverlay,commit,importOwnerReviews,loadForRead,overlayCatalogBody,OWNER_REVIEWS_KEY,readAuthority,readDocument,revertOwnerReviews,stampLocalized} from '../src/owner-review-d1.js';
import {readAuthority as readCacheAuthority} from '../src/metadata-cache.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-owner-review-'));
let databases=0;
const names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0009_owner_review_authority'];
const migrated=(list=names)=>{
 const file=path.join(root,'review-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of list)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const ownerLoc=(value)=>({status:'reviewed',value,provenance:{authority:'owner'},updatedAt:'2026-11-01T00:00:00.000Z'});
const filmSlice=(value,extra={})=>({filmId:'film:heat',localization:ownerLoc(value),aliases:[{kind:'title',value:'Старое'}],titleReviews:[{requestId:'req-1',version:{before:'title-review:1:a',after:'title-review:1:b'}}],localizationConflicts:[{value:'Словарь',source:'dictionary',reason:'owner_kept'}],...extra});
const personSlice=(value)=>({localization:ownerLoc(value),aliases:[],nameReviews:[{requestId:'req-p',version:{before:'name-review:1:a',after:'name-review:1:b'}}],localizationConflicts:[],roleLinks:[{id:'person:director/ada',roleId:'director/ada'}]});

assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/owner-review-d1\.js','OwnerReview'\)/);
assert.match(fs.readFileSync('migrations/0009_owner_review_authority.sql','utf8'),/CASE WHEN version < 9 THEN 9 ELSE version END/);
assert.doesNotMatch(fs.readFileSync('src/admin/film-title-route.js','utf8'),/programme\.json|titles\.json|people\.json|published-generation|\.prepare\(|D1/);
assert.equal((await readAuthority(null)).legacy,true);

{
 const db=migrated();
 assert.equal(one(db,'SELECT version FROM schema_contract'),9);
 assert.equal(one(db,"SELECT mode FROM owner_review_authority"),'r2');
 assert.equal(one(db,"SELECT COUNT(*) FROM sqlite_master WHERE name='prediction_domain_authority'"),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM sqlite_master WHERE name='published_epg_authority'"),0);
 assert.equal((await readAuthority(db)).mode,'r2');
 assert.equal((await readCacheAuthority(db)).mode,'r2');
 db.sql("UPDATE metadata_cache_authority SET mode='d1'");
 assert.equal((await readCacheAuthority(db)).mode,'d1','schema v9 still honours the metadata-cache marker');
 const higher=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache']);
 higher.sql("UPDATE schema_contract SET version=8, note='later'");
 higher.sql(fs.readFileSync('migrations/0009_owner_review_authority.sql','utf8').replace(/;\s*$/,''));
 assert.equal(one(higher,'SELECT version FROM schema_contract'),9);
 const ahead=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache']);
 ahead.sql("UPDATE schema_contract SET version=10, note='kept'");
 ahead.sql(fs.readFileSync('migrations/0009_owner_review_authority.sql','utf8').replace(/;\s*$/,''));
 assert.equal(one(ahead,'SELECT version FROM schema_contract'),10);
 assert.equal(one(ahead,'SELECT note FROM schema_contract'),'kept');
 assert.throws(()=>db.sql('UPDATE schema_contract SET version=7'),/schema_contract_downgrade/);
 db.sql("UPDATE schema_contract SET version = CASE WHEN version < 7 THEN 7 ELSE version END");
 assert.equal(one(db,'SELECT version FROM schema_contract'),9);
 db.sql("UPDATE schema_contract SET version = CASE WHEN version >= 7 AND version < 8 THEN 8 ELSE version END");
 assert.equal(one(db,'SELECT version FROM schema_contract'),9);
 const v6=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache']);
 assert.equal((await readAuthority(v6)).legacy,true);
 const base=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'];
 const forward=migrated([...base,'0007_prediction_authority','0009_owner_review_authority']);
 assert.equal(one(forward,'SELECT version FROM schema_contract'),9);
 assert.equal(one(forward,"SELECT mode FROM prediction_domain_authority"),'r2');
 assert.equal(one(forward,"SELECT mode FROM owner_review_authority"),'r2');
 const reverse=migrated([...base,'0009_owner_review_authority','0007_prediction_authority']);
 assert.equal(one(reverse,'SELECT version FROM schema_contract'),9);
 assert.equal(one(reverse,"SELECT mode FROM prediction_domain_authority"),'r2');
 assert.equal(one(reverse,"SELECT mode FROM owner_review_authority"),'r2');
 assert.match(one(reverse,'SELECT note FROM schema_contract'),/Schema v7/);
}

{
 const db=migrated();
 const bucket=new MemoryBucket();
 await assert.rejects(importOwnerReviews(db,bucket,{}),/owner_review_confirm/);
 const absent=await importOwnerReviews(db,bucket,{confirm:'load'});
 assert.equal(absent.absent,true);
 assert.equal(absent.entries,0);
 assert.equal(absent.mode,'r2');
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),0);
 const bad=new MemoryBucket();
 bad.put(OWNER_REVIEWS_KEY,'{');
 await assert.rejects(importOwnerReviews(migrated(),bad,{confirm:'load'}),/owner_review_unreadable/);
 const versioned=new MemoryBucket();
 versioned.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:2,films:{},people:{}}));
 await assert.rejects(importOwnerReviews(migrated(),versioned,{confirm:'load'}),/owner_review_shape/);
 const partial=new MemoryBucket();
 partial.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:1,films:{}}));
 await assert.rejects(importOwnerReviews(migrated(),partial,{confirm:'load'}),/owner_review_shape/);
 const throwing={async get(){throw new Error('403');},async head(){throw new Error('403');},async put(){throw new Error('403');}};
 await assert.rejects(importOwnerReviews(migrated(),throwing,{confirm:'load'}),/owner_review_unreadable/);
}

{
 const db=migrated();
 db.sql("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:heat',1,'Heat','2026-11-01T00:00:00.000Z')");
 db.sql("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:new',1,'New','2026-11-01T00:00:00.000Z')");
 db.sql("INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old','film:new','2026-11-01T00:00:00.000Z')");
 db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:heat','tmdb','949',1,0)");
 db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:heat','tmdb_tv','949',1,0)");
 db.sql("INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/ada','actor/ada',1,'2026-11-01T00:00:00.000Z')");
 const document={contractVersion:1,films:{heat:filmSlice('Хозяин'),old:filmSlice('Старый'),'tmdb_949':filmSlice('По номеру'),'tmdb_tv_949':filmSlice('Не телевизор'),orphan:filmSlice('Сирота')},people:{'person:actor/ada':personSlice('Ада'),'person:actor/missing':personSlice('Нет строки')}};
 const bucket=new MemoryBucket();
 bucket.put(OWNER_REVIEWS_KEY,JSON.stringify(document));
 const imported=await importOwnerReviews(db,bucket,{confirm:'load'});
 assert.equal(imported.entries,7);
 assert.equal(imported.films,2,'the import does not mint a film');
 assert.equal(imported.people,1,'the import does not mint a person');
 const links=db.sql('SELECT kind, source_key, identity_link, identity_state FROM owner_review_entry ORDER BY kind, source_key');
 const link=(key)=>links.find(row=>row.source_key===key);
 assert.equal(link('heat').identity_link,'film:heat');
 assert.equal(link('heat').identity_state,'verified');
 assert.equal(link('old').identity_link,'film:new');
 assert.equal(link('tmdb_949').identity_link,'film:heat');
 assert.equal(link('tmdb_tv_949').identity_state,'held');
 assert.equal(link('tmdb_tv_949').identity_link,null);
 assert.equal(link('orphan').identity_state,'held');
 assert.equal(link('person:actor/ada').identity_state,'verified');
 assert.equal(link('person:actor/missing').identity_state,'held');
 const round=await readDocument(db);
 assert.deepEqual(round.films.orphan.titleReviews,document.films.orphan.titleReviews);
 assert.deepEqual(round.people['person:actor/ada'].roleLinks,document.people['person:actor/ada'].roleLinks);
 assert.equal(one(db,"SELECT mode FROM owner_review_authority"),'r2');
 const moved=new MemoryBucket();
 moved.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:1,films:{},people:{}}));
 await assert.rejects(activateOwnerReviews(db,moved,{confirm:'activate'}),/owner_review_fence/);
 assert.equal(one(db,"SELECT mode FROM owner_review_authority"),'r2');
 const activated=await activateOwnerReviews(db,bucket,{confirm:'activate'});
 assert.equal(activated.mode,'d1');
 const lagging=new MemoryBucket();
 lagging.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:1,films:{heat:filmSlice('Зеркало')},people:{}}));
 let puts=0;
 const wrapped={async get(key){return lagging.get(key);},async head(key){return lagging.head(key);},async put(){puts++;throw new Error('mirror down');}};
 await assert.rejects(revertOwnerReviews(db,wrapped,{confirm:'r2'}),/owner_review_fence/);
 assert.equal(puts,1);
 assert.equal(one(db,"SELECT mode FROM owner_review_authority"),'d1','a failed mirror leaves the marker');
 const loaded=await loadForRead({DB:db,BUCKET:lagging});
 assert.equal(loaded.mode,'d1');
 assert.equal(loaded.body.films.heat.localization.value,'Хозяин');
 assert.equal(puts,1,'a d1 read does not repair the mirror');
}

{
 const db=migrated();
 const bucket=new MemoryBucket();
 const empty={contractVersion:1,films:{},people:{}};
 const bare=await commit({DB:migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache']),BUCKET:bucket},{expectedRevision:null,document:empty});
 assert.equal(bare,null,'schema v6 has no owner-review marker and keeps the caller on its R2 put');
 const fenced=await commit({DB:db,BUCKET:bucket},{expectedRevision:null,document:{...empty,films:{heat:filmSlice('Хозяин')},people:{'person:actor/ada':personSlice('Ада')}}});
 assert.equal(fenced.ok,true);
 assert.equal(one(db,'SELECT COUNT(*) FROM owner_review_entry'),0,'an r2 save does not write rows');
 assert.equal(JSON.parse(bucket.objects.get(OWNER_REVIEWS_KEY).text).people['person:actor/ada'].localization.value,'Ада');
 const again=await commit({DB:db,BUCKET:bucket},{expectedRevision:fenced.revision,document:{...empty,films:{heat:filmSlice('Дальше')},people:JSON.parse(bucket.objects.get(OWNER_REVIEWS_KEY).text).people}});
 assert.equal(again.ok,true);
 assert.equal(JSON.parse(bucket.objects.get(OWNER_REVIEWS_KEY).text).films.heat.localization.value,'Дальше');
 assert.equal(JSON.parse(bucket.objects.get(OWNER_REVIEWS_KEY).text).people['person:actor/ada'].roleLinks.length,1);
 const keys=[...bucket.objects.keys()];
 assert.deepEqual(keys,[OWNER_REVIEWS_KEY]);
}

{
 const db=migrated();
 const bucket=new MemoryBucket();
 bucket.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:1,films:{heat:filmSlice('Хозяин')},people:{'person:actor/ada':personSlice('Ада')}}));
 await importOwnerReviews(db,bucket,{confirm:'load'});
 await activateOwnerReviews(db,bucket,{confirm:'activate'});
 const gate=await readAuthority(db);
 const filmEdit={contractVersion:1,films:{heat:filmSlice('Новое'),other:filmSlice('Второе')},people:(await readDocument(db)).people};
 const saved=await commit({DB:db,BUCKET:bucket},{expectedRevision:gate.revision,document:filmEdit});
 assert.equal(saved.ok,true);
 const personEdit={contractVersion:1,films:(await readDocument(db)).films,people:{'person:actor/ada':personSlice('Ада'),'person:director/ada':personSlice('Режиссёр')}};
 const broken={...db,async batch(){throw new Error('batch down');}};
 const lost=await commit({DB:broken,BUCKET:bucket},{expectedRevision:saved.revision,document:personEdit});
 assert.equal(lost.ok,false);
 assert.equal((await readDocument(db)).films.heat.localization.value,'Новое');
 assert.equal((await readDocument(db)).people['person:director/ada'],undefined,'a failed person batch leaves no half-written role');
 const both=await commit({DB:db,BUCKET:bucket},{expectedRevision:(await readAuthority(db)).revision,document:personEdit});
 assert.equal(both.ok,true);
 assert.equal((await readDocument(db)).films.other.localization.value,'Второе');
 assert.equal((await readDocument(db)).people['person:director/ada'].localization.value,'Режиссёр');
 const stale=await commit({DB:db,BUCKET:bucket},{expectedRevision:'etag-from-r2',document:personEdit});
 assert.equal(stale.reason,'version_conflict');
 const quiet=new MemoryBucket();
 let writes=0;
 quiet.put=async()=>{writes++;return {etag:'x'};};
 const read=await loadForRead({DB:db,BUCKET:quiet});
 assert.equal(read.ok,true);
 assert.equal(writes,0);
}

{
 const dictionary='Словарь';
 const programme={films:[{id:'heat',title:dictionary,titleRu:dictionary,titleStatus:'reviewed',original:'Heat'}]};
 const document={contractVersion:1,films:{heat:filmSlice('Хозяин')},people:{}};
 const markers=['r2','d1'];
 for(const published of markers)for(const reviews of markers)for(const cache of markers)for(const prediction of markers){
  const copy=structuredClone(programme);
  stampLocalized(copy,document);
  assert.equal(copy.films[0].title,'Хозяин',published+'/'+reviews+'/'+cache+'/'+prediction);
  assert.equal(copy.films[0].titleAuthority,'owner');
  const view={films:[{id:'film:heat',localization:{status:'reviewed',value:dictionary,provenance:{authority:'dictionary'}}}] ,people:[]};
  applyViewOverlay(view,document);
  assert.equal(view.films[0].localization.value,'Хозяин');
  assert.equal(view.films[0].localization.provenance.authority,'owner');
 }
 const catalog=overlayCatalogBody({id:'film:heat',title:dictionary,credits:[{id:'person:actor/ada',localName:'Словарь'}]},{contractVersion:1,films:{heat:filmSlice('Хозяин')},people:{'person:actor/ada':personSlice('Ада')}});
 assert.equal(catalog.title,'Хозяин');
 assert.equal(catalog.credits[0].localName,'Ада');
}

{
 const script=path.resolve('scripts/owner-review-authority.mjs');
 const quiet=spawnSync('node',[script],{encoding:'utf8'});
 assert.equal(quiet.status,0);
 assert.equal(JSON.parse(quiet.stdout).writes,false);
 const refused=spawnSync('node',[script,'--database','/tmp/iptv/cloud.sqlite','--reviews','/tmp/reviews.json','--load','--confirm','load'],{encoding:'utf8'});
 assert.equal(refused.status,2);
 assert.match(refused.stderr,/production/);
}

console.log('owner review D1 authority: marker, lossless import, shared generation, overlay');
