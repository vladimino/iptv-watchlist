import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadLocalCatalog} from '../scripts/local-fixtures.mjs';
import {importFixtures} from '../scripts/local-store.mjs';
import {installLocalD1,splitStatements,migrationFiles} from '../scripts/local-d1.mjs';
import {importSnapshotStore} from '../scripts/local-store.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const build=spawnSync(process.execPath,[path.join(root,'build.mjs')],{cwd:root,stdio:'inherit'});
assert.equal(build.status,0);
const worker=await import(pathToFileURL(path.join(root,'dist/server/index.js')).href);
const bucket=new MemoryBucket();
const catalog=await loadLocalCatalog();
await importFixtures(bucket,catalog);
// AIR-576: the dev stack's own D1 install over a sqlite3 stand-in (the booted dev server on the real Miniflare D1 and R2 is tests/local-dev-smoke.mjs). No
// `*_DB_OPTIONAL` stand-in flag is set: these are the strict production paths, so a domain that is empty or invalid cannot pass as healthy.
const dbFile=path.join(os.tmpdir(),'iptv-local-api-'+process.pid+'.sqlite');
fs.rmSync(dbFile,{force:true});
const db=d1Standin(dbFile);
await installLocalD1({BUCKET:bucket,DB:db},{catalog});
const env={BUCKET:bucket,DB:db};

async function get(pathname,environment=env){
 const response=await worker.default.fetch(new Request('http://127.0.0.1'+pathname),environment);
 assert.equal(response.status,200,pathname);
 return response.json();
}
const programme=await get('/api/programme');
assert.deepEqual(programme.films.map(film=>film.title),['Movie1','Movie2','Movie3']);
const watchlist=await get('/api/watchlist');
assert.deepEqual(watchlist.films.map(film=>film.title),['Movie1','Movie2','Movie3']);
const started=await get('/api/started');
assert.deepEqual(started.ids,['movie-1'],'the started mark is a D1 row');

// The view is derived from D1: the ratings row, the fingerprints and the prediction pointer, each verified against its immutable R2 body.
const view=await get('/api/enrichment/view');
assert.equal(view.profile.version,1);
assert.deepEqual(Object.keys(view.films).sort(),['movie-1','movie-2']);
assert.equal(view.films['movie-1'].actualRating,4.5);
assert.equal(view.films['movie-1'].watched,true);
assert.deepEqual(view.films['movie-1'].fingerprint.plotMechanics,['heist']);
assert.deepEqual(view.films['movie-1'].moodIds,['tense']);
assert.equal(view.films['movie-1'].fingerprint.execution.pace,'fast');
assert.equal(view.films['movie-1'].prediction,null);
assert.equal(view.films['movie-2'].prediction.predictedRating,4);
assert.equal(view.films['movie-2'].prediction.probability4Plus,0.7);
assert.equal(view.films['movie-2'].prediction.stale,false,'the prediction names the active profile');
assert.equal(view.films['movie-2'].actualRating,null);
assert.equal(view.films['movie-3'],undefined,'a film without ratings, fingerprint or prediction has no entry');

const available=await get('/api/catalog/available');
assert.equal(available.programmeRunId,'local-fixture');
assert.equal(available.pinned,true);
const footer=await get('/api/enrichment/footer/status');
assert.deepEqual(footer.profile,{version:1});
assert.deepEqual([footer.collection.state,footer.collection.total,footer.collection.watched,footer.collection.rated,footer.collection.watchlist],['ok',3,1,1,3]);
const events=await get('/api/events');
assert.deepEqual(events.events.map(event=>event.type).sort(),['epg','started','unstarted','watchlist']);
assert.deepEqual((await get('/api/ui/filter-presets')).presets,[]);

const overview=await get('/api/admin/overview');
assert.equal(overview.snapshot.programmeRunId,'local-fixture');
assert.deepEqual(overview.counts,{films:3,people:3});
assert.equal(overview.queues.find(item=>item.kind==='film'&&item.code==='identity-unresolved').count,2,'movie-2 and movie-3 carry no TMDB id');
assert.equal(overview.queues.find(item=>item.kind==='film'&&item.code==='localization-provisional').count,1);
const adminFilms=await get('/api/admin/films?q=movie');
assert.deepEqual(adminFilms.items.map(item=>[item.id,item.identity.status,item.localization.status]),[['film:movie-1','resolved','missing'],['film:movie-2','unresolved','provisional'],['film:movie-3','unresolved','missing']]);
assert.equal(adminFilms.items[0].canonicalIdentity,'tmdb:900001');
const adminPeople=await get('/api/admin/people?q=actor');
assert.deepEqual(adminPeople.items.map(item=>[item.id,item.preferred,item.localization.status]),[['person:actor/actor-1',null,'missing'],['person:actor/actor-2','Актёр 2','provisional']]);
const adminDetail=await get('/api/admin/people/person:director/director-1');
assert.equal(adminDetail.item.original,'Director1');
const health=await get('/api/admin/health');
assert.equal(health.snapshot.programmeRunId,'local-fixture');
assert.match(health.pin,/d1%3Ap1\.q0\.r1|d1%3A1/,'the health pin carries the D1 generations');
await get('/api/admin/limbo');

// Refusals: an incomplete or unavailable D1 fails closed, never to the raw object and never to a healthy-looking empty answer.
const refused=async(label,environment,pathname='/api/enrichment/view')=>{
 const response=await worker.default.fetch(new Request('http://127.0.0.1'+pathname),environment);
 assert.ok([409,502,503].includes(response.status),label+' answered '+response.status);
 const body=await response.json();
 assert.equal(body.films,undefined,label);
 return body;
};
await refused('no D1 binding',{BUCKET:bucket,PREDICTION_DB_REQUIRED:'on'});
// A schema older than the prediction and ratings domains (migrations 0001-0007 only), the shape the stand-in flags used to cover.
const oldFile=path.join(os.tmpdir(),'iptv-local-old-'+process.pid+'.sqlite');
fs.rmSync(oldFile,{force:true});
const oldDb=d1Standin(oldFile);
for(const item of (await migrationFiles()).slice(0,7))for(const statement of splitStatements(item.sql))await oldDb.prepare(statement).run();
await refused('a schema below the ratings domain',{BUCKET:bucket,DB:oldDb});
// The same database with a domain marker back on r2: the view stops at the ratings gate.
const r2File=path.join(os.tmpdir(),'iptv-local-r2-'+process.pid+'.sqlite');
fs.copyFileSync(dbFile,r2File);
const r2Db=d1Standin(r2File);
r2Db.sql("UPDATE prediction_domain_authority SET mode='r2'");
await refused('prediction domain not authoritative',{BUCKET:bucket,DB:r2Db});
// A profile or fingerprint row whose immutable body is changed is refused (the Worker verifies the SHA-256 of the body it reads).
const tamperedBucket=new MemoryBucket();
await importFixtures(tamperedBucket,catalog);
for(const [key,item] of bucket.objects)if(!tamperedBucket.objects.has(key))tamperedBucket.objects.set(key,{...item});
tamperedBucket.objects.set('enrichment/profile/versions/1.json',{text:JSON.stringify({version:1,profileHash:'local-fixture',createdAt:'tampered'}),customMetadata:{}});
const mismatch=await refused('a changed profile body',{BUCKET:tamperedBucket,DB:db});
assert.match(mismatch.error,/prediction_domain_body_mismatch/);
// Reads stay answered with the stand-in absent in production: the published programme itself comes from D1.
const emptyFile=path.join(os.tmpdir(),'iptv-local-empty-'+process.pid+'.sqlite');
fs.rmSync(emptyFile,{force:true});
const emptyDb=d1Standin(emptyFile);
const blocked=await worker.default.fetch(new Request('http://127.0.0.1/api/enrichment/view'),{BUCKET:bucket,DB:emptyDb});
assert.equal(blocked.status,502);
assert.match((await blocked.json()).error,/published_epg_unavailable|ratings_domain_not_authoritative/);

// A private snapshot store end to end: its own R2 documents plus the operator's d1Sql, read through the Worker. The canonical Film/Person rows come from the
// snapshot's programme, titles.json and people.json, so the localized title, the cached name and the TMDB claim survive the move to the D1 authority.
{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-local-snap-'));
 try{
  const {fingerprintContentHash}=await import('../src/prediction-d1.js');
  const objects={
   'programme.json':{runId:'snap',updatedAt:new Date().toISOString(),window:{from:Date.now()-3600000,to:Date.now()+86400000},watchlistCount:1,films:[{id:'snap-1',tmdbId:'900100',title:'Snap1',original:'Snap1',year:2019,runtime:95,genres:['G'],synopsis:'S',directors:[{id:'director/snap-d',name:'SnapD'}],actors:[{id:'actor/snap-a',name:'SnapA'}],shows:[]}],people:{directors:[],actors:[]},stats:{uniqueFilms:0,channels:0}},
   'watchlist.json':{updatedAt:new Date().toISOString(),films:[{id:'snap-1',tmdbId:'900100',title:'Snap1'}]},
   'titles.json':{'snap-1':{title:'Снимок',status:'provisional',sources:['https://example.test/snap']}},
   'people.json':{'actor/snap-a':{name:'Снимок Актёр'}},
   'enrichment/profile/versions/1.json':{version:1,profileHash:'snap-profile'},
   'started/snap-1.json':{id:'snap-1',started:true,startedAt:new Date().toISOString()},
  };
  fs.mkdirSync(path.join(dir,'entries'));fs.mkdirSync(path.join(dir,'objects'));fs.writeFileSync(path.join(dir,'manifest.json'),'{}\n');
  let n=0;
  for(const [key,json] of Object.entries(objects)){const name=String(++n).padStart(4,'0');fs.writeFileSync(path.join(dir,'objects',name+'.json'),JSON.stringify(json));fs.writeFileSync(path.join(dir,'entries',name+'.json'),JSON.stringify({key,file:'objects/'+name+'.json',metadata:{httpMetadata:{contentType:'application/json'}}}));}
  const sql=path.join(dir,'rows.sql');
  fs.writeFileSync(sql,"INSERT INTO prediction_profile (version, profile_hash, active, created_at, r2_key, content_sha256) VALUES (1,'snap-profile',1,'2026-10-01T00:00:00.000Z','enrichment/profile/versions/1.json','"+await fingerprintContentHash(objects['enrichment/profile/versions/1.json'])+"');\nINSERT INTO ratings_view (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES ('snap-1','snap:1',1,3.5,NULL,1,'2026-10-01T00:00:00.000Z');\n");
  const snapFile=path.join(os.tmpdir(),'iptv-local-snapdb-'+process.pid+'.sqlite');
  fs.rmSync(snapFile,{force:true});
  const snapEnv={BUCKET:new MemoryBucket(),DB:d1Standin(snapFile)};
  await importSnapshotStore(snapEnv,dir,{d1Sql:sql});
  const snapOverview=await get('/api/admin/overview',snapEnv);
  assert.equal(snapOverview.snapshot.programmeRunId,'snap');
  assert.equal(snapOverview.queues.find(item=>item.kind==='film'&&item.code==='localization-provisional').count,1,'the snapshot title is a provisional localization in D1');
  assert.equal(snapOverview.queues.find(item=>item.kind==='film'&&item.code==='identity-unresolved').count,0,'the snapshot TMDB claim is trusted in D1');
  const snapFilms=await get('/api/admin/films?q=snap',snapEnv);
  assert.deepEqual(snapFilms.items.map(item=>[item.id,item.identity.status,item.localization.status]),[['film:snap-1','resolved','provisional']]);
  assert.equal(snapFilms.items[0].canonicalIdentity,'tmdb:900100');
  const snapPeople=await get('/api/admin/people?q=snap',snapEnv);
  assert.deepEqual(snapPeople.items.map(item=>[item.id,item.preferred,item.localization.status]),[['person:actor/snap-a','Снимок Актёр','provisional'],['person:director/snap-d',null,'missing']]);
  assert.equal((await get('/api/started',snapEnv)).ids[0],'snap-1');
  const snapView=await get('/api/enrichment/view',snapEnv);
  assert.equal(snapView.films['snap-1'].actualRating,3.5);
  fs.rmSync(snapFile,{force:true});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
for(const file of [dbFile,oldFile,r2File,emptyFile])fs.rmSync(file,{force:true});
console.log('Local API: programme, started, view, Finds, footer and admin read the local D1 and match the fixture catalog; an incomplete D1 refuses');
