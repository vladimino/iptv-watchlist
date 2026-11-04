// ADR 0081. Owner reviews stay on R2 until migration 0009 is applied and the marker
// is switched. The switch is not part of this test. No production database is opened.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {activateOwnerReviews,applyViewOverlay,commit,importOwnerReviews,loadForRead,loadSnapshotReviews,overlayCatalogBody,OWNER_REVIEW_MAX_STATEMENT_BYTES,OWNER_REVIEW_MAX_STATEMENTS,OWNER_REVIEWS_KEY,readAuthority,readDocument,readFenced,revertOwnerReviews,stampLocalized} from '../src/owner-review-d1.js';
import {publishGeneration} from '../src/published-epg.js';
import {readAuthority as readCacheAuthority} from '../src/metadata-cache.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-owner-review-'));
let databases=0;
const base=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'];
const names=[...base,'0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority'];
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
assert.match(fs.readFileSync('migrations/0009_owner_review_authority.sql','utf8'),/version >= 8 AND version < 9/);
assert.match(fs.readFileSync('src/admin/film-title-route.js','utf8'),/owner_review_too_large[\s\S]{0,240},413\)/);
assert.match(fs.readFileSync('src/admin/person-name-route.js','utf8'),/owner_review_too_large[\s\S]{0,240},413\)/);
assert.doesNotMatch(fs.readFileSync('src/admin/film-title-route.js','utf8'),/programme\.json|titles\.json|people\.json|published-generation|\.prepare\(|D1/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/OWNER_REVIEW_DB_OPTIONAL/);
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/OWNER_REVIEW_DB_OPTIONAL/);
assert.match(fs.readFileSync('scripts/local-dev.mjs','utf8'),/OWNER_REVIEW_DB_OPTIONAL:'standin'/);
assert.equal((await readAuthority(null)).failClosed,true);
assert.equal((await readAuthority({OWNER_REVIEW_DB_OPTIONAL:'standin'})).legacy,true);

const sql0009=fs.readFileSync('migrations/0009_owner_review_authority.sql','utf8');
function refuses(list){
 const db=migrated(list);
 let refused=false;
 try{db.sql(sql0009);}catch{refused=true;}
 assert.equal(refused,true);
 assert.equal(one(db,"SELECT COUNT(*) FROM sqlite_master WHERE name='owner_review_authority'"),0);
 return db;
}

{
 const db=migrated();
 assert.equal(one(db,'SELECT version FROM schema_contract'),9);
 assert.equal(one(db,"SELECT mode FROM owner_review_authority"),'r2');
 assert.equal(one(db,"SELECT mode FROM prediction_domain_authority"),'r2');
 assert.equal(one(db,"SELECT mode FROM published_epg_authority"),'r2');
 assert.equal((await readAuthority(db)).mode,'r2');
 assert.equal((await readCacheAuthority(db)).mode,'r2');
 db.sql("UPDATE metadata_cache_authority SET mode='d1'");
 assert.equal((await readCacheAuthority(db)).mode,'d1','schema v9 still honours the metadata-cache marker');
 assert.throws(()=>db.sql('UPDATE schema_contract SET version=7'),/schema_contract_downgrade/);
 const v6=refuses(base);
 assert.equal(one(v6,'SELECT version FROM schema_contract'),6);
 assert.equal((await readAuthority(v6)).legacy,true);
 const v7=refuses([...base,'0007_prediction_authority']);
 assert.equal(one(v7,'SELECT version FROM schema_contract'),7);
 const partial=migrated([...base,'0007_prediction_authority','0008_published_epg_authority']);
 partial.sql('DROP TABLE published_epg_show');
 let partialRefused=false;
 try{partial.sql(sql0009);}catch{partialRefused=true;}
 assert.equal(partialRefused,true,'a partial version 8 creates no owner-review table');
 assert.equal(one(partial,'SELECT version FROM schema_contract'),8);
 assert.equal(one(partial,"SELECT COUNT(*) FROM sqlite_master WHERE name='owner_review_authority'"),0);
 const empty=d1Standin(path.join(root,'empty-'+(databases++)+'.sqlite'));
 assert.equal((await readAuthority(empty)).failClosed,true);
 assert.equal((await readAuthority({DB:empty,OWNER_REVIEW_DB_OPTIONAL:'standin'})).legacy,true);
 const missingRow=migrated(base);
 missingRow.sql('DELETE FROM schema_contract');
 assert.equal((await readAuthority(missingRow)).failClosed,true);
 const numbered=migrated(base);
 numbered.sql('UPDATE schema_contract SET version=9');
 assert.equal((await readAuthority(numbered)).failClosed,true,'version 9 without the owner-review tables does not fall back to R2');
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

function manyFilms(count,value){
 const films={};
 for(let index=0;index<count;index++)films['k'+index]=filmSlice(value);
 return {contractVersion:1,films,people:{}};
}
function fenceDb(db,{onFence,always=false}={}){
 let pending=true;
 return {
  prepare(sql){
   const prepared=db.prepare(sql);
   return {
    bind(...params){
     const statement=prepared.bind(...params);
     return {
      async first(){
       const row=await statement.first();
       if(pending&&onFence&&sql.startsWith('SELECT mode, generation, writes FROM owner_review_authority')){
        if(!always)pending=false;
        onFence();
       }
       return row;
      },
      all:()=>statement.all(),
      run:()=>statement.run(),
     };
    },
   };
  },
  batch:statements=>db.batch(statements),
  sql:text=>db.sql(text),
 };
}
async function activated(){
 const db=migrated();
 const bucket=new MemoryBucket();
 const document={contractVersion:1,films:{heat:filmSlice('Хозяин')},people:{'person:director/ada':personSlice('Ада')}};
 bucket.put(OWNER_REVIEWS_KEY,JSON.stringify(document));
 await importOwnerReviews(db,bucket,{confirm:'load'});
 await activateOwnerReviews(db,bucket,{confirm:'activate'});
 return {db,bucket,document};
}

{
 const {db,bucket}=await activated();
 const generation=one(db,'SELECT generation FROM owner_review_authority');
 const saved=await commit({DB:db,BUCKET:bucket},{expectedRevision:'d1:'+generation,document:manyFilms(OWNER_REVIEW_MAX_STATEMENTS,'Много')});
 assert.equal(saved.ok,false);
 assert.equal(saved.reason,'owner_review_too_large');
 assert.equal(one(db,'SELECT generation FROM owner_review_authority'),generation);
 assert.equal(one(db,'SELECT COUNT(*) FROM owner_review_entry'),2);
 assert.equal((await readDocument(db)).films.heat.localization.value,'Хозяин');
 const wide=await commit({DB:db,BUCKET:bucket},{expectedRevision:'d1:'+generation,document:{contractVersion:1,films:{heat:filmSlice('Жирный',{note:'x'.repeat(OWNER_REVIEW_MAX_STATEMENT_BYTES)})},people:{}}});
 assert.equal(wide.reason,'owner_review_too_large');
 assert.equal((await readDocument(db)).films.heat.localization.value,'Хозяин');
 const fresh=migrated();
 const source=new MemoryBucket();
 source.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:1,films:{heat:filmSlice('Хозяин')},people:{}}));
 await importOwnerReviews(fresh,source,{confirm:'load'});
 const huge=new MemoryBucket();
 huge.put(OWNER_REVIEWS_KEY,JSON.stringify(manyFilms(OWNER_REVIEW_MAX_STATEMENTS,'Много')));
 await assert.rejects(importOwnerReviews(fresh,huge,{confirm:'load'}),/owner_review_too_large/);
 assert.equal(one(fresh,'SELECT COUNT(*) FROM owner_review_entry'),1);
 assert.equal((await readDocument(fresh)).films.heat.localization.value,'Хозяин');
}

{
 const {db,bucket}=await activated();
 const raced=fenceDb(db,{onFence(){
  const next=JSON.stringify(filmSlice('После')).replaceAll("'","''");
  db.sql('UPDATE owner_review_authority SET generation=generation+1');
  db.sql('UPDATE owner_review_entry SET generation=generation+1');
  db.sql("UPDATE owner_review_entry SET payload_json='"+next+"' WHERE kind='film' AND source_key='heat'");
 }});
 const snap=await readFenced({DB:raced});
 assert.equal(snap.ok,true);
 assert.equal(snap.generation,2);
 assert.equal(snap.body.films.heat.localization.value,'После');
 assert.equal(snap.body.films.heat.localization.value==='Хозяин',false);
 const loaded=await loadForRead({DB:raced,BUCKET:bucket});
 assert.equal(loaded.ok,true);
 assert.equal(loaded.revision,'d1:2');
 assert.equal(loaded.body.films.heat.localization.value,'После');
 const shaky=fenceDb(db,{always:true,onFence(){db.sql('UPDATE owner_review_authority SET generation=generation+1');}});
 const lost=await loadForRead({DB:shaky,BUCKET:bucket});
 assert.equal(lost.ok,false);
 assert.equal(lost.body,null);
 await assert.rejects(loadSnapshotReviews({DB:shaky}),/owner_review_unavailable/);
}

{
 const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const worker=(await import(pathToFileURL(path.resolve('dist/server/index.js')).href)).default;
 const programme={runId:'run-owner',updatedAt:'2026-11-01T12:00:00.000Z',watchlistCount:1,films:[{id:'heat',title:'Словарь',titleRu:'Словарь',original:'Heat',directors:[{id:'director/ada',name:'Словарь',original:'Ada'}],shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'heat',title:'Словарь',directors:[{id:'director/ada',name:'Словарь',original:'Ada'}]}]};
 const ctx={waitUntil(){}};
 async function scene(epgMode,reviewMode){
  const db=migrated();
  const bucket=new MemoryBucket();
  const puts=[];
  const tracked={
   async get(key){return bucket.get(key);},
   async head(key){return bucket.head(key);},
   async put(key,body,options){puts.push(key);return bucket.put(key,body,options);},
  };
  if(epgMode==='d1'){
   db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
   await publishGeneration({DB:db},{programmeRunId:'run-owner',phase:'published',expectedProgrammeRunId:null,programme,watchlist},{now:0});
  }else{
   bucket.put('epg/published-generation.json',JSON.stringify({programmeRunId:'run-owner',phase:'published'}));
   bucket.put('epg/generations/run-owner/programme.json',JSON.stringify(programme));
   bucket.put('watchlist.json',JSON.stringify(watchlist));
  }
  const document={contractVersion:1,films:{heat:filmSlice('Хозяин')},people:{'person:director/ada':personSlice('Ада')}};
  bucket.put(OWNER_REVIEWS_KEY,JSON.stringify(document));
  if(reviewMode==='d1'){
   await importOwnerReviews(db,bucket,{confirm:'load'});
   await activateOwnerReviews(db,bucket,{confirm:'activate'});
   bucket.put(OWNER_REVIEWS_KEY,JSON.stringify({contractVersion:1,films:{heat:filmSlice('Зеркало')},people:{}}));
  }
  return {db,bucket,tracked,puts};
 }
 for(const epgMode of ['r2','d1'])for(const reviewMode of ['r2','d1']){
  const {db,tracked,puts}=await scene(epgMode,reviewMode);
  const env={DB:db,BUCKET:tracked};
  const response=await worker.fetch(new Request('http://127.0.0.1/api/programme'),env,ctx);
  const body=await response.json();
  assert.equal(response.status,200,epgMode+'/'+reviewMode+' '+JSON.stringify(body));
  assert.equal(body.runId,'run-owner');
  assert.equal(body.films.length,1);
  assert.equal(body.films[0].title,'Хозяин');
  assert.equal(body.films[0].titleAuthority,'owner');
  assert.equal(body.films[0].directors[0].name,'Ада');
  assert.equal(JSON.stringify(body).includes('Зеркало'),false);
  const admin=await worker.fetch(new Request('http://127.0.0.1/api/admin/films/film%3Aheat'),env,ctx);
  const item=await admin.json();
  assert.equal(admin.status,200,epgMode+'/'+reviewMode+' admin '+JSON.stringify(item));
  assert.equal(item.item.preferred,'Хозяин');
  assert.equal(puts.includes(OWNER_REVIEWS_KEY),false,epgMode+'/'+reviewMode);
 }
 for(const epgMode of ['r2','d1']){
  const {db,bucket,tracked,puts}=await scene(epgMode,'d1');
  db.sql('DROP TABLE owner_review_entry');
  const env={DB:db,BUCKET:tracked};
  const response=await worker.fetch(new Request('http://127.0.0.1/api/programme'),env,ctx);
  const body=await response.json();
  assert.equal(response.status,503);
  assert.equal(body.reason,'owner_review_unavailable');
  assert.equal(body.films,undefined);
  assert.equal(JSON.stringify(body).includes('Зеркало'),false);
  const admin=await worker.fetch(new Request('http://127.0.0.1/api/admin/films/film%3Aheat'),env,ctx);
  const item=await admin.json();
  assert.equal(admin.status,503,JSON.stringify(item));
  assert.equal(item.reason,'owner_review_unavailable');
  assert.equal(puts.includes(OWNER_REVIEWS_KEY),false);
  assert.equal(bucket.objects.get(OWNER_REVIEWS_KEY).text.includes('Зеркало'),true);
 }
 const raced=await scene('r2','d1');
 const before=one(raced.db,'SELECT generation FROM owner_review_authority');
 const wrapped=fenceDb(raced.db,{onFence(){
  const next=JSON.stringify(filmSlice('После')).replaceAll("'","''");
  raced.db.sql('UPDATE owner_review_authority SET generation=generation+1');
  raced.db.sql('UPDATE owner_review_entry SET generation=generation+1');
  raced.db.sql("UPDATE owner_review_entry SET payload_json='"+next+"' WHERE kind='film' AND source_key='heat'");
 }});
 const env={DB:wrapped,BUCKET:raced.tracked};
 const response=await worker.fetch(new Request('http://127.0.0.1/api/programme'),env,ctx);
 const body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body));
 assert.equal(body.films[0].title,'После');
 const after=one(raced.db,'SELECT generation FROM owner_review_authority');
 assert.equal(after,before+1);
 const admin=await worker.fetch(new Request('http://127.0.0.1/api/admin/films/film%3Aheat'),env,ctx);
 const item=await admin.json();
 assert.equal(admin.status,200,JSON.stringify(item));
 assert.equal(item.item.preferred,'После');
 const pin=item.pin.split('|').map(decodeURIComponent);
 assert.equal(pin.at(-1),'d1:'+after);
 assert.equal(raced.puts.includes(OWNER_REVIEWS_KEY),false);
}

console.log('owner review D1 authority: marker, fence, budget, built overlay');
