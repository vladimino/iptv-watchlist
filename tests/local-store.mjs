import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadLocalCatalog} from '../scripts/local-fixtures.mjs';
import {importDecision,importFixtures,importSnapshot,markerPath,persistDirectory,prepareLocalStore,readStoreReady,storeKey,viewIndexReady,writeMarker} from '../scripts/local-store.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const identity={snapshot:'fixtures',manifestBytes:3,manifestMtimeMs:4};
assert.equal(importDecision({refresh:true,marker:{...identity},identity,ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:null,identity,ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity},identity,ready:false}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity,manifestBytes:9},identity,ready:true}),'replace');
assert.equal(importDecision({refresh:false,marker:{...identity},identity,ready:true}),'skip');
assert.equal(viewIndexReady({'movie-1':{actualRating:4.5,fingerprint:{moodLabels:['tense']}}}),true);
assert.equal(viewIndexReady({films:{'movie-1':{actualRating:4.5}}}),false);
assert.equal(viewIndexReady({}),true);
assert.equal(viewIndexReady(null),false);

const home='/home/someone/private-snapshot';
assert.equal(storeKey({snapshot:'fixtures'}),'fixtures');
assert.equal(storeKey({snapshot:home}).startsWith('snapshot-'),true);
assert.equal(persistDirectory('/state',{snapshot:home}).includes('someone'),false);
assert.notEqual(persistDirectory('/state',identity),persistDirectory('/state',{snapshot:home,manifestBytes:1,manifestMtimeMs:1}));
assert.equal(storeKey({snapshot:home}),storeKey({snapshot:home}));

const root=await mkdtemp(path.join(tmpdir(),'iptv-local-store-'));
try{
 const catalog=await loadLocalCatalog();
 const snapshotDir=path.join(root,'snapshot');
 await writeSnapshot(snapshotDir);
 const state=path.join(root,'state');
 const fixtureDir=persistDirectory(state,identity);
 const snapshotIdentity={snapshot:snapshotDir,manifestBytes:2,manifestMtimeMs:2};
 const snapshotDirStore=persistDirectory(state,snapshotIdentity);
 const buckets=new Map();
 const bucketFor=dir=>{if(!buckets.has(dir))buckets.set(dir,new MemoryBucket());return buckets.get(dir);};
 const open=dir=>async()=>({env:{BUCKET:bucketFor(dir)},dispose:async()=>{}});
 let fixtureImports=0;
 const imported=await prepareLocalStore({
  identity,persistDir:fixtureDir,openBucket:open(fixtureDir),
  importInto:async bucket=>{fixtureImports++;return importFixtures(bucket,catalog);},
 });
 assert.equal(imported.action,'replace');
 assert.equal(fixtureImports,1);
 assert.equal((await readStoreReady(bucketFor(fixtureDir))),true);
 const marker=JSON.parse(await readFile(markerPath(fixtureDir),'utf8'));
 assert.equal(marker.snapshot,'fixtures');
 assert.equal(marker.objects,imported.objects);

 const skipped=await prepareLocalStore({
  identity,persistDir:fixtureDir,openBucket:open(fixtureDir),
  importInto:async()=>{fixtureImports++;throw new Error('should skip');},
 });
 assert.equal(skipped.action,'skip');
 assert.equal(fixtureImports,1);

 await rm(path.join(fixtureDir,'v3'),{recursive:true,force:true});
 bucketFor(fixtureDir).objects.clear();
 const restored=await prepareLocalStore({
  identity,persistDir:fixtureDir,openBucket:open(fixtureDir),
  importInto:async bucket=>{fixtureImports++;return importFixtures(bucket,catalog);},
 });
 assert.equal(restored.action,'replace','marker exists but the store was deleted');
 assert.equal(fixtureImports,2);
 assert.equal((await readStoreReady(bucketFor(fixtureDir))),true);

 const snapshotImported=await prepareLocalStore({
  identity:snapshotIdentity,persistDir:snapshotDirStore,openBucket:open(snapshotDirStore),
  importInto:bucket=>importSnapshot(bucket,snapshotDir),
 });
 assert.equal(snapshotImported.action,'replace');
 assert.match(snapshotImported.message,/Execution values attached for 1 of 1/);
 const snapshotBucket=bucketFor(snapshotDirStore);
 const fixtureBucket=bucketFor(fixtureDir);
 assert.equal(JSON.parse(snapshotBucket.objects.get('events/personal.json').text).secret,true);
 assert.equal(fixtureBucket.objects.has('events/personal.json'),false);
 assert.equal(snapshotBucket.objects.has('started/movie-1.json'),false);
 assert.equal(JSON.parse(snapshotBucket.objects.get('enrichment/view-index.json').text)['private-1'].fingerprint.execution.pace,'fast');
 assert.equal(JSON.parse(fixtureBucket.objects.get('programme.json').text).films[0].title,'Movie1');

 fixtureBucket.objects.set('events/personal.json',{text:'{"secret":true}',customMetadata:{}});
 await prepareLocalStore({
  refresh:true,identity,persistDir:fixtureDir,openBucket:open(fixtureDir),
  importInto:bucket=>importFixtures(bucket,catalog),
 });
 assert.equal(fixtureBucket.objects.has('events/personal.json'),false);
 assert.equal(snapshotBucket.objects.has('events/personal.json'),true);

 snapshotBucket.objects.set('started/movie-1.json',{text:'{"id":"movie-1"}',customMetadata:{}});
 await prepareLocalStore({
  refresh:true,identity:snapshotIdentity,persistDir:snapshotDirStore,openBucket:open(snapshotDirStore),
  importInto:bucket=>importSnapshot(bucket,snapshotDir),
 });
 assert.equal(snapshotBucket.objects.has('started/movie-1.json'),false);
 assert.equal(fixtureBucket.objects.has('started/movie-1.json'),true);
 assert.equal(JSON.parse(fixtureBucket.objects.get('programme.json').text).films[0].title,'Movie1');

 const broken=path.join(root,'broken');
 await writeMarker(markerPath(broken),identity,{objects:1});
 await assert.rejects(()=>prepareLocalStore({
  identity,persistDir:broken,openBucket:async()=>({env:{BUCKET:new MemoryBucket()},dispose:async()=>{}}),
  importInto:async bucket=>{await bucket.put('sync.json','{}');return {objects:1,message:'partial'};},
 }),/film view index/);
 await assert.rejects(()=>readFile(markerPath(broken),'utf8'));
}finally{
 await rm(root,{recursive:true,force:true});
}
console.log('Local store: separate fixture and snapshot buckets, refresh replacement, and deleted-store restore passed');

async function writeSnapshot(dir){
 const objects={
  'programme.json':{runId:'snap',updatedAt:'2026-10-01T00:00:00.000Z',films:[{id:'private-1',title:'Private1',shows:[]}],watchlistCount:1,people:{directors:[],actors:[]},stats:{uniqueFilms:0,channels:0}},
  'watchlist.json':{updatedAt:'2026-10-01T00:00:00.000Z',films:[{id:'private-1',title:'Private1'}]},
  'enrichment/view-index.json':{'private-1':{actualRating:5,fingerprintHash:'snap-hash',fingerprint:{plotMechanics:['rescue'],moodLabels:['light'],fingerprintHash:'snap-hash'}}},
  'enrichment/films/private-1/fingerprint.json':{execution:{pace:'fast',decision_logic:'strong',plot_engine:'unknown'}},
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
