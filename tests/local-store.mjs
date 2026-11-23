import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadLocalCatalog} from '../scripts/local-fixtures.mjs';
import {migrationsIdentity} from '../scripts/local-d1.mjs';
import {importDecision,importFixtureStore,importSnapshotStore,markerPath,miniflareDirectory,persistDirectory,prepareLocalStore,readStoreReady,storeKey,writeMarker} from '../scripts/local-store.mjs';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const migrations=await migrationsIdentity();
const identity={snapshot:'fixtures',manifestBytes:3,manifestMtimeMs:4,migrations};
assert.equal(importDecision({refresh:true,marker:{...identity},identity,ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:null,identity,ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity},identity,ready:false}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity,manifestBytes:9},identity,ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity,migrations:'older-chain'},identity,ready:true}),'replace','a store built from another migration chain is imported again');
assert.equal(importDecision({refresh:false,marker:{...identity,d1Sql:'a:1:1'},identity:{...identity,d1Sql:'a:2:1'},ready:true}),'replace','a changed D1 input file is imported again');
assert.equal(importDecision({refresh:false,marker:{...identity},identity,ready:true}),'skip');

const home='/home/someone/private-snapshot';
assert.equal(storeKey({snapshot:'fixtures'}),'fixtures');
assert.equal(storeKey({snapshot:home}).startsWith('snapshot-'),true);
assert.equal(persistDirectory('/state',{snapshot:home}).includes('someone'),false);
assert.notEqual(persistDirectory('/state',identity),persistDirectory('/state',{snapshot:home,manifestBytes:1,manifestMtimeMs:1}));
assert.equal(storeKey({snapshot:home}),storeKey({snapshot:home}));

const root=await mkdtemp(path.join(tmpdir(),'iptv-local-store-'));
const rows=(file,sql)=>{const result=sqliteSync(['-json','-bail',file],{input:sql,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
try{
 const catalog=await loadLocalCatalog();
 const snapshotDir=path.join(root,'snapshot');
 await writeSnapshot(snapshotDir);
 const d1Sql=path.join(root,'snapshot-d1.sql');
 await writeFile(d1Sql,"INSERT INTO prediction_profile (version, profile_hash, active, created_at, r2_key, content_sha256) VALUES (1,'snap-profile',1,'2026-10-01T00:00:00.000Z','enrichment/profile/versions/1.json','"+await sha({version:1,profileHash:'snap-profile'})+"');\nINSERT INTO ratings_view (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES ('private-1','snap:private-1',1,5,NULL,1,'2026-10-01T00:00:00.000Z');\n");
 const state=path.join(root,'state');
 const fixtureDir=persistDirectory(state,identity);
 const snapshotIdentity={snapshot:snapshotDir,manifestBytes:2,manifestMtimeMs:2,migrations,d1Sql:'input:1:1'};
 const snapshotDirStore=persistDirectory(state,snapshotIdentity);
 // A store seam over the sqlite3 D1 stand-in and a memory bucket. Like Miniflare, a store whose directory was deleted opens empty, and the directory is made on first use.
 const stores=new Map();
 const storeFor=dir=>{
  const holder=miniflareDirectory(dir);
  if(!stores.has(dir)||!existsSync(holder)){
   const file=path.join(root,'d1-'+stores.size+'-'+Date.now()+'.sqlite');
   stores.set(dir,{bucket:new MemoryBucket(),file});
  }
  return stores.get(dir);
 };
 const open=dir=>async()=>{const store=storeFor(dir);await mkdir(miniflareDirectory(dir),{recursive:true});return {env:{BUCKET:store.bucket,DB:d1Standin(store.file)},dispose:async()=>{}};};
 const envOf=dir=>({BUCKET:stores.get(dir).bucket,DB:d1Standin(stores.get(dir).file)});
 let fixtureImports=0;
 const importFixture=async env=>{fixtureImports++;return importFixtureStore(env,catalog);};
 const imported=await prepareLocalStore({identity,persistDir:fixtureDir,openStore:open(fixtureDir),importInto:importFixture});
 assert.equal(imported.action,'replace');
 assert.equal(fixtureImports,1);
 assert.match(imported.message,/Local D1 at schema version \d+: \d+ migrations, \d+ synthetic rows, generation local-fixture published/);
 assert.equal(await readStoreReady(envOf(fixtureDir)),true);
 const marker=JSON.parse(await readFile(markerPath(fixtureDir),'utf8'));
 assert.equal(marker.snapshot,'fixtures');
 assert.equal(marker.migrations,migrations);
 assert.equal(marker.objects,imported.objects);

 const skipped=await prepareLocalStore({identity,persistDir:fixtureDir,openStore:open(fixtureDir),importInto:async()=>{fixtureImports++;throw new Error('should skip');}});
 assert.equal(skipped.action,'skip');
 assert.equal(fixtureImports,1);

 // A migration added after the store was built: the marker names the old chain, so the store is imported again.
 const newer=await prepareLocalStore({identity:{...identity,migrations:'a-later-chain'},persistDir:fixtureDir,openStore:open(fixtureDir),importInto:importFixture});
 assert.equal(newer.action,'replace');
 assert.equal(fixtureImports,2);

 // A store with an incomplete D1 (here: a marker moved off d1) is imported again instead of being served.
 const broken1=stores.get(fixtureDir).file;
 rows(broken1,"DROP TRIGGER IF EXISTS started_authority_transition;UPDATE started_authority SET mode='r2'");
 assert.equal(await readStoreReady(envOf(fixtureDir)),false,'a marker off d1 is not a ready store');
 const repaired=await prepareLocalStore({identity:{...identity,migrations:'a-later-chain'},persistDir:fixtureDir,openStore:open(fixtureDir),importInto:importFixture});
 assert.equal(repaired.action,'replace');
 assert.equal(fixtureImports,3);
 assert.equal(await readStoreReady(envOf(fixtureDir)),true);

 await rm(path.join(fixtureDir,'v3'),{recursive:true,force:true});
 const restored=await prepareLocalStore({identity:{...identity,migrations:'a-later-chain'},persistDir:fixtureDir,openStore:open(fixtureDir),importInto:importFixture});
 assert.equal(restored.action,'replace','marker exists but the store was deleted');
 assert.equal(fixtureImports,4);
 assert.equal(await readStoreReady(envOf(fixtureDir)),true);

 const snapshotImported=await prepareLocalStore({
  identity:snapshotIdentity,persistDir:snapshotDirStore,openStore:open(snapshotDirStore),
  importInto:env=>importSnapshotStore(env,snapshotDir,{d1Sql}),
 });
 assert.equal(snapshotImported.action,'replace');
 assert.match(snapshotImported.message,/Execution values attached for 1 of 1/);
 assert.match(snapshotImported.message,/2 operator rows, 0 started marks, generation snap published/);
 const snapshotBucket=stores.get(snapshotDirStore).bucket;
 const fixtureBucket=stores.get(fixtureDir).bucket;
 const snapshotFile=stores.get(snapshotDirStore).file,fixtureFile=stores.get(fixtureDir).file;
 assert.notEqual(snapshotFile,fixtureFile);
 assert.equal(JSON.parse(snapshotBucket.objects.get('events/personal.json').text).secret,true);
 assert.equal(fixtureBucket.objects.has('events/personal.json'),false);
 assert.equal(snapshotBucket.objects.has('started/movie-1.json'),false);
 assert.equal(JSON.parse(snapshotBucket.objects.get('enrichment/view-index.json').text)['private-1'].fingerprint.execution.pace,'fast');
 assert.equal(JSON.parse(fixtureBucket.objects.get('programme.json').text).films[0].title,'Movie1');
 // The two D1 stores hold their own rows: the snapshot's ratings are the operator's input, the fixture's are the synthetic ones.
 assert.deepEqual(rows(snapshotFile,'SELECT alias_id FROM ratings_view').map(row=>row.alias_id),['private-1']);
 assert.deepEqual(rows(fixtureFile,'SELECT alias_id FROM ratings_view').map(row=>row.alias_id),['movie-1']);
 assert.deepEqual(rows(snapshotFile,'SELECT programme_run_id FROM published_epg_authority').map(row=>row.programme_run_id),['snap']);
 assert.deepEqual(rows(fixtureFile,'SELECT programme_run_id FROM published_epg_authority').map(row=>row.programme_run_id),['local-fixture']);

 fixtureBucket.objects.set('events/personal.json',{text:'{"secret":true}',customMetadata:{}});
 rows(fixtureFile,"INSERT INTO started_mark (id, started, started_at, last_event_json, rev) VALUES ('extra',1,'2026-01-01T00:00:00.000Z',NULL,1)");
 await prepareLocalStore({refresh:true,identity,persistDir:fixtureDir,openStore:open(fixtureDir),importInto:importFixture});
 assert.equal(stores.get(fixtureDir).bucket.objects.has('events/personal.json'),false);
 assert.equal(snapshotBucket.objects.has('events/personal.json'),true);
 assert.deepEqual(rows(stores.get(fixtureDir).file,'SELECT id FROM started_mark').map(row=>row.id),['movie-1'],'--refresh rebuilds the selected store only: the extra row is gone');
 assert.deepEqual(rows(snapshotFile,'SELECT alias_id FROM ratings_view').map(row=>row.alias_id),['private-1'],'the other store is left in place');

 snapshotBucket.objects.set('started/movie-1.json',{text:'{"id":"movie-1"}',customMetadata:{}});
 await prepareLocalStore({
  refresh:true,identity:snapshotIdentity,persistDir:snapshotDirStore,openStore:open(snapshotDirStore),
  importInto:env=>importSnapshotStore(env,snapshotDir,{d1Sql}),
 });
 assert.equal(stores.get(snapshotDirStore).bucket.objects.has('started/movie-1.json'),false);
 assert.equal(stores.get(fixtureDir).bucket.objects.has('started/movie-1.json'),true);
 assert.equal(JSON.parse(stores.get(fixtureDir).bucket.objects.get('programme.json').text).films[0].title,'Movie1');

 // A snapshot store without its D1 input is refused before anything is imported, and the marker is not written.
 const noInput=path.join(root,'no-input');
 await assert.rejects(()=>prepareLocalStore({identity:{...snapshotIdentity,snapshot:path.join(root,'other')},persistDir:noInput,openStore:open(noInput),importInto:env=>importSnapshotStore(env,snapshotDir,{d1Sql:''})}),/No D1 input.*d1Sql/);
 await assert.rejects(()=>readFile(markerPath(noInput),'utf8'));

 const broken=path.join(root,'broken');
 await writeMarker(markerPath(broken),identity,{objects:1});
 await assert.rejects(()=>prepareLocalStore({
  identity,persistDir:broken,openStore:open(broken),
  importInto:async env=>{await env.BUCKET.put('sync.json','{}');return {objects:1,message:'partial'};},
 }),/incomplete/);
 await assert.rejects(()=>readFile(markerPath(broken),'utf8'));
}finally{
 await rm(root,{recursive:true,force:true});
}
console.log('Local store: separate fixture and snapshot stores (R2 and D1), refresh replacement, migration and incomplete-D1 re-import, deleted-store restore and the snapshot D1 input passed');

async function sha(value){
 const {fingerprintContentHash}=await import('../src/prediction-d1.js');
 return fingerprintContentHash(value);
}
async function writeSnapshot(dir){
 const objects={
  'programme.json':{runId:'snap',updatedAt:'2026-10-01T00:00:00.000Z',films:[{id:'private-1',title:'Private1',shows:[]}],watchlistCount:1,people:{directors:[],actors:[]},stats:{uniqueFilms:0,channels:0}},
  'watchlist.json':{updatedAt:'2026-10-01T00:00:00.000Z',films:[{id:'private-1',title:'Private1'}]},
  'enrichment/view-index.json':{'private-1':{actualRating:5,fingerprintHash:'snap-hash',fingerprint:{plotMechanics:['rescue'],moodLabels:['light'],fingerprintHash:'snap-hash'}}},
  'enrichment/films/private-1/fingerprint.json':{execution:{pace:'fast',decision_logic:'strong',plot_engine:'unknown'}},
  'enrichment/profile/versions/1.json':{version:1,profileHash:'snap-profile'},
  'events/personal.json':{secret:true},
 };
 await mkdir(path.join(dir,'entries'),{recursive:true});
 await mkdir(path.join(dir,'objects'),{recursive:true});
 await writeFile(path.join(dir,'manifest.json'),'{}\n');
 let index=0;
 for(const [key,json] of Object.entries(objects)){
  const file=`objects/${String(++index).padStart(4,'0')}.json`;
  await writeFile(path.join(dir,file),JSON.stringify(json));
  await writeFile(path.join(dir,'entries',`${String(index).padStart(4,'0')}.json`),JSON.stringify({key,file,metadata:{httpMetadata:{contentType:'application/json'}}}));
 }
}
