// ADR 0078. The production entry stays read-only unless a command names iptv and its own confirm.
// These cases inject a local binding and an in-memory bucket. They do not call the network.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createD1Adapter} from '../scripts/d1-backfill.mjs';
import {createPredictionBinding, runPredictionDomainProduction} from '../scripts/prediction-domain-production.mjs';
import {PRODUCTION_ACCOUNT_ID} from '../scripts/metadata-cache-production.mjs';
import {fingerprintContentHash, fingerprintPointerAgrees, openLease, openQueue, writeLease, writeQueue} from '../src/prediction-d1.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const NOW=Date.parse('2026-11-01T10:00:00.000Z');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-production-'));
let databases=0;
const names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority'];
function migrated(last){
 const file=path.join(root,'prediction-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of names){
  if(name>last)break;
  db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 }
 db.file=file;
 return db;
}
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const queueText=db=>db.sql('SELECT chunk_text FROM prediction_queue ORDER BY seq').map(row=>row.chunk_text).join('');
const put=(bucket,key,value)=>bucket.put(key,JSON.stringify(value));
const argv=(...args)=>['node','prediction-domain-production.mjs',...args];
async function run(args,binding,store){
 return runPredictionDomainProduction({argv:argv(...args),binding,store,now:()=>NOW,fetchImpl(){throw new Error('network');}});
}

const script=path.resolve('scripts/prediction-domain-production.mjs');
const bare=spawnSync(process.execPath,[script],{encoding:'utf8'});
assert.equal(bare.status,0,bare.stderr);
assert.deepEqual(JSON.parse(bare.stdout),{configured:false,writes:false,writeState:'none'});
const missingConfirm=spawnSync(process.execPath,[script,'--load','--target','iptv'],{encoding:'utf8'});
assert.equal(missingConfirm.status,2);
assert.match(missingConfirm.stderr,/confirm/);
const badTarget=spawnSync(process.execPath,[script,'--activate','--confirm','activate','--target','other'],{encoding:'utf8'});
assert.equal(badTarget.status,2);
assert.match(badTarget.stderr,/target_invalid/);

const calls={n:0};
const quiet=await runPredictionDomainProduction({argv:argv(),fetchImpl(){calls.n++;throw new Error('network');}});
assert.equal(quiet.exit,0);
assert.equal(quiet.result.writes,false);
assert.equal(calls.n,0);
const refused=await runPredictionDomainProduction({argv:argv('--load','--target','iptv'),binding:{prepare(){throw new Error('binding used');}},fetchImpl(){throw new Error('network');}});
assert.equal(refused.exit,2);
assert.equal(refused.result.reason,'confirm');

assert.doesNotMatch(fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'),/INSERT\s+INTO\s+film\b/i);
const v6=migrated('0006_metadata_cache');
const idle=new MemoryBucket();
const drained=['--apply','--confirm','apply','--producers-drained','--target','iptv'];
const undrainedDb=migrated('0006_metadata_cache');
let undrainedFetches=0;
const undrained=await runPredictionDomainProduction({argv:argv('--apply','--confirm','apply','--target','iptv'),binding:undrainedDb,fetchImpl(){undrainedFetches++;throw new Error('network');},now:()=>NOW});
assert.equal(undrained.exit,2);
assert.equal(undrained.result.reason,'producers_not_drained');
assert.equal(undrained.result.writes,false);
assert.equal(undrained.result.writeState,'none');
assert.equal(undrainedFetches,0);
assert.equal(one(undrainedDb,"SELECT COUNT(*) FROM sqlite_master WHERE name='prediction_domain_authority'"),0);
const busyApplyDb=migrated('0006_metadata_cache');
const busyApplyBucket=new MemoryBucket();
await put(busyApplyBucket,'enrichment/runner-lease.json',{runId:'run-live',expiresAt:NOW+60000});
const busyApply=await run(drained,busyApplyDb,busyApplyBucket);
assert.equal(busyApply.exit,3);
assert.equal(busyApply.result.reason,'prediction_domain_busy');
assert.equal(busyApply.result.writes,false);
assert.equal(one(busyApplyDb,"SELECT COUNT(*) FROM sqlite_master WHERE name='prediction_domain_authority'"),0);
const blindDb=migrated('0006_metadata_cache');
const blind=await run(drained,blindDb,{async get(){throw new Error('r2 down');}});
assert.equal(blind.exit,3);
assert.equal(blind.result.reason,'quiescence_unproven');
assert.equal(blind.result.writes,false);
assert.equal(one(blindDb,"SELECT COUNT(*) FROM sqlite_master WHERE name='prediction_domain_authority'"),0);
const applied=await run(drained,v6,idle);
assert.equal(applied.exit,0,JSON.stringify(applied.result));
assert.equal(applied.result.writes,true);
assert.equal(applied.result.schemaVersion,7);
assert.equal(applied.result.mode,'r2');
assert.equal(applied.result.generation,0);
assert.equal(one(v6,'SELECT COUNT(*) FROM film'),0);
const ahead=migrated('0006_metadata_cache');
ahead.sql('UPDATE schema_contract SET version=8');
const raised=await run(drained,ahead,idle);
assert.equal(raised.exit,0,JSON.stringify(raised.result));
assert.equal(raised.result.schemaVersion,8);
assert.equal(one(ahead,'SELECT version FROM schema_contract'),8);
assert.equal(one(ahead,"SELECT mode FROM prediction_domain_authority"),'r2');
const early=migrated('0006_metadata_cache');
early.sql('UPDATE schema_contract SET version=5');
const refusedVersion=await run(drained,early,idle);
assert.equal(refusedVersion.exit,3);
assert.equal(refusedVersion.result.reason,'schema_unexpected');
assert.equal(refusedVersion.result.writes,false);
assert.equal(one(early,"SELECT COUNT(*) FROM sqlite_master WHERE name='prediction_domain_authority'"),0);
assert.match(fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'),/CASE WHEN version < 7 THEN 7 ELSE version END/);
const again=await run(drained,v6,idle);
assert.equal(again.exit,3);
assert.equal(again.result.reason,'already_applied');
assert.equal(again.result.writes,false);

const claimed=migrated('0007_prediction_authority');
claimed.sql('UPDATE prediction_domain_authority SET generation=1');
const claimedBucket=new MemoryBucket();
await put(claimedBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['caught']});
const loaded=await run(['--load','--confirm','load','--target','iptv'],claimed,claimedBucket);
assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
assert.equal(loaded.result.mode,'r2');
assert.equal(loaded.result.generation,1);
assert.equal(loaded.result.attempts,1);
assert.match(queueText(claimed),/caught/);

const busy=migrated('0007_prediction_authority');
const busyBucket=new MemoryBucket();
await put(busyBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['held']});
await put(busyBucket,'enrichment/runner-lease.json',{runId:'run-live',expiresAt:NOW+60000});
const blocked=await run(['--load','--confirm','load','--target','iptv'],busy,busyBucket);
assert.equal(blocked.exit,3);
assert.equal(blocked.result.reason,'prediction_domain_busy');
assert.equal(blocked.result.writes,false);
assert.equal(one(busy,'SELECT COUNT(*) FROM prediction_queue'),0);

const racedFile=path.join(root,'raced.sqlite');
let bumped=false;
const raced=d1Standin(racedFile,{onBatch(){
 if(bumped)return;
 bumped=true;
 const update=spawnSync('sqlite3',['-bail',racedFile],{input:'UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1;\n',encoding:'utf8'});
 if(update.status!==0)throw new Error(update.stderr);
}});
for(const name of names)raced.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
const racedBucket=new MemoryBucket();
await put(racedBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['retry']});
const retried=await run(['--load','--confirm','load','--target','iptv'],raced,racedBucket);
assert.equal(retried.exit,0,JSON.stringify(retried.result));
assert.equal(retried.result.attempts,2);
assert.equal(retried.result.generation,1);
assert.match(queueText(raced),/retry/);

const drift=migrated('0007_prediction_authority');
const driftBucket=new MemoryBucket();
await put(driftBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['a']});
const ready=await run(['--load','--confirm','load','--target','iptv'],drift,driftBucket);
assert.equal(ready.exit,0,JSON.stringify(ready.result));
await put(driftBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['b']});
const mismatch=await run(['--activate','--confirm','activate','--target','iptv'],drift,driftBucket);
assert.equal(mismatch.exit,3);
assert.equal(mismatch.result.reason,'prediction_domain_parity');
assert.equal(one(drift,"SELECT mode FROM prediction_domain_authority"),'r2');
assert.match(queueText(drift),/"a"/);

const body={filmId:'solo',fingerprintHash:'print-2',plotMechanics:[],moodLabels:[],execution:{}};
const record={...body,generatedAt:'2026-11-01T04:00:00.000Z',invalidatedAt:null,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,produced:'generated',previous:null};
const missing=migrated('0007_prediction_authority');
const missingBucket=new MemoryBucket();
await put(missingBucket,'enrichment/films/solo/fingerprint.json',record);
await put(missingBucket,'enrichment/films/solo/fingerprints/print-2.json',body);
const imported=await run(['--load','--confirm','load','--target','iptv'],missing,missingBucket);
assert.equal(imported.exit,0,JSON.stringify(imported.result));
const gap=migrated('0007_prediction_authority');
const gapBucket=new MemoryBucket();
await put(gapBucket,'enrichment/films/solo/fingerprint.json',record);
for(let index=0;index<5001;index++)await put(gapBucket,'enrichment/films/solo/noise/'+index+'.json',{index});
const gapped=await run(['--load','--confirm','load','--target','iptv'],gap,gapBucket);
assert.equal(gapped.exit,3);
assert.equal(gapped.result.reason,'prediction_domain_body_missing');
assert.equal(gapped.result.writes,false);
assert.equal(gapped.result.writeState,'none');
assert.equal(one(gap,"SELECT writes FROM prediction_domain_authority"),'open');
assert.equal(one(gap,'SELECT COUNT(*) FROM prediction_fingerprint'),0);
const keptRecord={filmId:'kept',fingerprintHash:'h-kept',plotMechanics:[],moodLabels:[],execution:{},generatedAt:'2026-11-01T01:00:00.000Z',fingerprintSchemaVersion:1,fingerprintPromptVersion:1};
const crowded={
 async get(key){
  if(key==='enrichment/films/kept/fingerprint.json'||key==='enrichment/films/kept/fingerprints/h-kept.json')return {json:async()=>keptRecord};
  return null;
 },
 async list(){
  const objects=[{key:'enrichment/films/kept/fingerprint.json'}];
  for(let index=0;index<5001;index++)objects.push({key:'enrichment/other/'+index+'.json'});
  return {objects,truncated:false};
 },
};
const crowdedDb=migrated('0007_prediction_authority');
const crowdedLoad=await run(['--load','--confirm','load','--target','iptv'],crowdedDb,crowded);
assert.equal(crowdedLoad.exit,0,JSON.stringify(crowdedLoad.result));
assert.equal(one(crowdedDb,'SELECT COUNT(*) FROM prediction_fingerprint'),1);
const overFilms={
 async get(){return null;},
 async list(){return {objects:Array.from({length:5001},(_,index)=>({key:'enrichment/films/f'+index+'/fingerprint.json'})),truncated:false};},
};
const over=await run(['--load','--confirm','load','--target','iptv'],migrated('0007_prediction_authority'),overFilms);
assert.equal(over.exit,3);
assert.equal(over.result.reason,'prediction_domain_budget');
assert.equal(over.result.writes,false);
assert.equal(over.result.writeState,'none');
const activated=await run(['--activate','--confirm','activate','--target','iptv'],missing,missingBucket);
assert.equal(activated.exit,0,JSON.stringify(activated.result));
assert.equal(activated.result.mode,'d1');
missingBucket.objects.delete('enrichment/films/solo/fingerprints/print-2.json');
const stuck=await run(['--revert','--confirm','r2','--target','iptv'],missing,missingBucket);
assert.equal(stuck.exit,3);
assert.equal(stuck.result.reason,'prediction_domain_body_missing');
assert.equal(one(missing,"SELECT mode FROM prediction_domain_authority"),'d1');

const repair=migrated('0007_prediction_authority');
const repairBucket=new MemoryBucket();
await put(repairBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['a']});
assert.equal((await run(['--load','--confirm','load','--target','iptv'],repair,repairBucket)).exit,0);
assert.equal((await run(['--activate','--confirm','activate','--target','iptv'],repair,repairBucket)).exit,0);
await put(repairBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['stale']});
const reverted=await run(['--revert','--confirm','r2','--target','iptv'],repair,repairBucket);
assert.equal(reverted.exit,0,JSON.stringify(reverted.result));
assert.equal(reverted.result.mode,'r2');
assert.deepEqual(JSON.parse(repairBucket.objects.get('enrichment/prediction-queue.json').text).pending,['a']);

const partialRevert=migrated('0007_prediction_authority');
const partialRevertBucket=new MemoryBucket();
await put(partialRevertBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['kept']});
assert.equal((await run(['--load','--confirm','load','--target','iptv'],partialRevert,partialRevertBucket)).exit,0);
assert.equal((await run(['--activate','--confirm','activate','--target','iptv'],partialRevert,partialRevertBucket)).exit,0);
let revertPuts=0;
const revertPut=partialRevertBucket.put.bind(partialRevertBucket);
partialRevertBucket.put=async(key,body,options)=>{
 revertPuts++;
 if(revertPuts===2)throw new Error('socket hang up');
 return revertPut(key,body,options);
};
const partialReverted=await run(['--revert','--confirm','r2','--target','iptv'],partialRevert,partialRevertBucket);
assert.equal(partialReverted.exit,3);
assert.equal(partialReverted.result.reason,'write_uncertain');
assert.equal(partialReverted.result.writes,true);
assert.equal(partialReverted.result.writeState,'unknown');
assert.ok(partialReverted.result.committedUnits>=1);
assert.notEqual(partialReverted.result.writeState,'none');
assert.equal(one(partialRevert,"SELECT mode FROM prediction_domain_authority"),'d1');

const ACCOUNT_ID=PRODUCTION_ACCOUNT_ID;
function installEnv(bucket,endpoint){
 return {R2_INSTALL_ACCESS_KEY_ID:'install-key',R2_INSTALL_SECRET_ACCESS_KEY:'install-secret',R2_INSTALL_ACCOUNT_ID:ACCOUNT_ID,R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT_ID,R2_SNAPSHOT_BUCKET:bucket,...(endpoint?{R2_SNAPSHOT_ENDPOINT:endpoint}:{})};
}
async function refusedRevert(env){
 const db=migrated('0007_prediction_authority');
 db.sql("UPDATE prediction_domain_authority SET mode='d1'");
 let fetches=0;
 const result=await runPredictionDomainProduction({argv:argv('--revert','--confirm','r2','--target','iptv'),env,binding:db,fetchImpl(){fetches++;throw new Error('network');},now:()=>NOW});
 assert.equal(fetches,0);
 assert.equal(result.result.writes,false);
 assert.equal(result.result.writeState,'none');
 assert.equal(one(db,"SELECT mode FROM prediction_domain_authority"),'d1');
 return result;
}
const wrongBucket=await refusedRevert(installEnv('other-bucket'));
assert.equal(wrongBucket.exit,3);
assert.equal(wrongBucket.result.reason,'bucket_identity');
const wrongEndpoint=await refusedRevert(installEnv('iptv','https://example.invalid'));
assert.equal(wrongEndpoint.exit,3);
assert.equal(wrongEndpoint.result.reason,'endpoint_refused');
const loopback=await refusedRevert(installEnv('iptv','http://127.0.0.1:9'));
assert.equal(loopback.exit,3);
assert.equal(loopback.result.reason,'endpoint_refused');

const crossed=migrated('0006_metadata_cache');
const crossedBucket=new MemoryBucket();
await put(crossedBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['old']});
await put(crossedBucket,'enrichment/runner-lease.json',{runId:'old',expiresAt:0});
const crossedEnv={DB:crossed,BUCKET:crossedBucket};
const crossedHead=await openQueue(crossedEnv);
const crossedLease=await openLease(crossedEnv,'enrichment/runner-lease.json');
assert.equal(crossedHead.tables,false);
assert.equal(crossedLease.tables,false);
assert.equal((await run(drained,crossed,crossedBucket)).exit,0);
assert.equal((await run(['--load','--confirm','load','--target','iptv'],crossed,crossedBucket)).exit,0);
assert.equal((await run(['--activate','--confirm','activate','--target','iptv'],crossed,crossedBucket)).exit,0);
let crossedPuts=0;
const crossedPut=crossedBucket.put.bind(crossedBucket);
crossedBucket.put=async(...args)=>{crossedPuts++;return crossedPut(...args);};
assert.equal(await writeQueue(crossedEnv,crossedHead,{schemaVersion:3,pending:['new']}),null);
assert.equal(await writeLease(crossedEnv,crossedLease,{runId:'late',expiresAt:NOW+60000}),null);
assert.equal(crossedPuts,0);
assert.match(queueText(crossed),/old/);
assert.doesNotMatch(queueText(crossed),/new/);
assert.equal(JSON.parse(crossedBucket.objects.get('enrichment/prediction-queue.json').text).pending[0],'old');
assert.equal(one(crossed,"SELECT mode FROM prediction_domain_authority"),'d1');
assert.equal(one(crossed,'SELECT COUNT(*) FROM prediction_domain_intent'),0);

const released=migrated('0007_prediction_authority');
const releasedBucket=new MemoryBucket();
await put(releasedBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['held-writers']});
assert.equal((await run(['--load','--confirm','load','--target','iptv'],released,releasedBucket)).exit,0);
assert.equal(one(released,"SELECT writes FROM prediction_domain_authority"),'held');
const opened=await run(['--release','--confirm','release','--target','iptv'],released);
assert.equal(opened.exit,0,JSON.stringify(opened.result));
assert.equal(opened.result.writes,true);
assert.equal(one(released,"SELECT writes FROM prediction_domain_authority"),'open');

const partialFile=path.join(root,'partial.sqlite');
let partialBatches=0;
const partialDb=d1Standin(partialFile,{onBatch(){partialBatches++;if(partialBatches===3)throw new Error('stop after two commits');}});
for(const name of names)partialDb.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
const partialBucket=new MemoryBucket();
await put(partialBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['partial']});
const partial=await run(['--load','--confirm','load','--target','iptv'],partialDb,partialBucket);
assert.equal(partial.exit,3);
assert.equal(partial.result.writes,true);
assert.equal(partial.result.writeState,'partial');
assert.ok(partial.result.committedUnits>=1);
assert.notEqual(partial.result.writeState,'none');

const pauseDb=migrated('0007_prediction_authority');
const pauseBucket=new MemoryBucket();
await put(pauseBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['old']});
let releasePut;
const pauseGate=new Promise(resolve=>{releasePut=resolve;});
let putStarted;
const putStartedGate=new Promise(resolve=>{putStarted=resolve;});
const originalPut=pauseBucket.put.bind(pauseBucket);
pauseBucket.put=async(key,body,options)=>{
 if(key==='enrichment/prediction-queue.json'&&String(body).includes('new')){putStarted();await pauseGate;}
 return originalPut(key,body,options);
};
const pauseEnv={DB:pauseDb,BUCKET:pauseBucket};
const writing=writeQueue(pauseEnv,await openQueue(pauseEnv),{schemaVersion:3,pending:['new']});
await putStartedGate;
const pausedLoad=await run(['--load','--confirm','load','--target','iptv'],pauseDb,pauseBucket);
assert.equal(pausedLoad.result.reason,'prediction_domain_busy');
assert.equal(pausedLoad.result.writes,true);
assert.equal(pausedLoad.result.writeState,'partial');
assert.equal(one(pauseDb,"SELECT mode FROM prediction_domain_authority"),'r2');
assert.equal(one(pauseDb,'SELECT COUNT(*) FROM prediction_queue'),0);
const pausedActivate=await run(['--activate','--confirm','activate','--target','iptv'],pauseDb,pauseBucket);
assert.equal(pausedActivate.result.reason,'prediction_domain_busy');
assert.equal(one(pauseDb,"SELECT mode FROM prediction_domain_authority"),'r2');
releasePut();
assert.ok(await writing);
assert.equal(one(pauseDb,'SELECT COUNT(*) FROM prediction_domain_intent'),0);
const pausedLoaded=await run(['--load','--confirm','load','--target','iptv'],pauseDb,pauseBucket);
assert.equal(pausedLoaded.exit,0,JSON.stringify(pausedLoaded.result));
assert.match(queueText(pauseDb),/new/);
assert.doesNotMatch(queueText(pauseDb),/old/);

const lateDb=migrated('0007_prediction_authority');
const lateBucket=new MemoryBucket();
await put(lateBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['old']});
let commitRemote;
const latePut=lateBucket.put.bind(lateBucket);
lateBucket.put=async(key,body,options)=>{
 if(key==='enrichment/prediction-queue.json'&&String(body).includes('late')){commitRemote=()=>latePut(key,body,options);throw new Error('socket hang up');}
 return latePut(key,body,options);
};
await assert.rejects(writeQueue({DB:lateDb,BUCKET:lateBucket},await openQueue({DB:lateDb,BUCKET:lateBucket}),{schemaVersion:3,pending:['late']}));
assert.equal(one(lateDb,'SELECT COUNT(*) FROM prediction_domain_intent'),1);
const earlyReconcile=await run(['--reconcile','--confirm','reconcile','--target','iptv'],lateDb,lateBucket);
assert.equal(earlyReconcile.result.reason,'prediction_domain_busy');
assert.equal(earlyReconcile.result.writes,false);
assert.equal(one(lateDb,'SELECT COUNT(*) FROM prediction_domain_intent'),1);
const lateLoad=await run(['--load','--confirm','load','--target','iptv'],lateDb,lateBucket);
assert.equal(lateLoad.result.reason,'prediction_domain_busy');
assert.equal(lateLoad.result.writes,true);
assert.equal(lateLoad.result.writeState,'partial');
assert.equal(one(lateDb,'SELECT COUNT(*) FROM prediction_queue'),0);
assert.equal(one(lateDb,"SELECT mode FROM prediction_domain_authority"),'r2');
const lateActivate=await run(['--activate','--confirm','activate','--target','iptv'],lateDb,lateBucket);
assert.equal(lateActivate.result.reason,'prediction_domain_busy');
assert.equal(one(lateDb,"SELECT mode FROM prediction_domain_authority"),'r2');
assert.equal((await run(['--release','--confirm','release','--target','iptv'],lateDb)).result.reason,'prediction_domain_busy');
await commitRemote();
const matched=await run(['--reconcile','--confirm','reconcile','--target','iptv'],lateDb,lateBucket);
assert.equal(matched.exit,0,JSON.stringify(matched.result));
assert.equal(matched.result.writes,true);
assert.equal(one(lateDb,'SELECT COUNT(*) FROM prediction_domain_intent'),0);
assert.equal((await run(['--release','--confirm','release','--target','iptv'],lateDb)).exit,0);
const copied=await run(['--load','--confirm','load','--target','iptv'],lateDb,lateBucket);
assert.equal(copied.exit,0,JSON.stringify(copied.result));
assert.match(queueText(lateDb),/late/);
assert.doesNotMatch(queueText(lateDb),/old/);

const ACCOUNT='0123456789abcdef0123456789abcdef';
const TOKEN='test-d1-token';
const TARGET='11111111-1111-4111-8111-111111111111';
const QUEUE_TARGET='22222222-2222-4222-8222-222222222222';
const DROP_TARGET='33333333-3333-4333-8333-333333333333';
const ROLL_TARGET='44444444-4444-4444-8444-444444444444';
function sqliteFile(file,input){const result=spawnSync('sqlite3',['-bail',file],{input,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;}
function httpDatabases(){
 const files={
  [TARGET]:migrated('0006_metadata_cache').file,
  [QUEUE_TARGET]:migrated('0007_prediction_authority').file,
  [DROP_TARGET]:migrated('0007_prediction_authority').file,
  [ROLL_TARGET]:path.join(root,'roll.sqlite'),
 };
 sqliteFile(files[ROLL_TARGET],'SELECT 1;');
 return files;
}
function fakeD1(files){
 const calls=[];
 const hooks=[];
 const server=http.createServer((request,response)=>{
  const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
   const url=new URL(request.url,'http://127.0.0.1');
   const match=url.pathname.match(/^\/client\/v4\/accounts\/([0-9a-f]{32})\/d1\/database\/([0-9a-f-]{36})(\/query)?$/);
   const send=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));};
   if(request.headers.authorization!=='Bearer '+TOKEN)return send(403,{success:false,errors:[{message:'Authentication error'}]});
   if(!match||match[1]!==ACCOUNT||!files[match[2]])return send(404,{success:false,errors:[{message:'Database not found'}]});
   if(request.method==='GET'&&!match[3])return send(200,{success:true,result:{uuid:match[2],name:'iptv'}});
   if(request.method!=='POST'||!match[3])return send(405,{success:false,errors:[{message:'Method not allowed'}]});
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const pieces=Array.isArray(body.batch)?body.batch.map(item=>String(item?.sql||'')):(typeof body.sql==='string'?body.sql.split(';').map(part=>part.trim()).filter(Boolean):null);
   if(!pieces)return send(400,{success:false,errors:[{message:'Missing SQL'}]});
   const sql=Array.isArray(body.batch)?pieces.join('\n'):body.sql;
   const call={database:match[2],sql,batch:Array.isArray(body.batch),body,write:pieces.some(text=>!/^\s*(SELECT|PRAGMA)\b/i.test(text))};
   calls.push(call);
   for(const hook of hooks){const verdict=await hook({...call,phase:'before'});if(typeof verdict==='number')return send(verdict,{success:false,errors:[{message:'Injected'}]});}
   const input='PRAGMA foreign_keys=ON;\n'+(call.write?'BEGIN;\n'+sql+'\nCOMMIT;\n':sql+'\n');
   const result=spawnSync('sqlite3',['-json','-bail',files[match[2]]],{input,encoding:'utf8',maxBuffer:1<<28});
   for(const hook of hooks){const after=await hook({...call,phase:'after',ok:result.status===0});if(after==='drop'){request.socket.destroy();return;}}
   if(result.status!==0)return send(400,{success:false,errors:[{message:(result.stderr||'SQL error').trim().slice(0,300)}]});
   const text=result.stdout.trim();
   const rows=text.startsWith('[')?JSON.parse(text.replace(/\]\s*\[/g,',')):[];
   const reported=pieces.map((item,index)=>({results:index===0?rows:[],success:true,meta:{changes:0}}));
   send(200,{success:true,result:reported});
  });
 });
 return {calls,hooks,async start(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port+'/client/v4';},async stop(){await new Promise(resolve=>server.close(resolve));}};
}
const files=httpDatabases();
const fake=fakeD1(files);
const endpoint=await fake.start();
function adapterFor(databaseId){
 return createD1Adapter({target:{accountId:ACCOUNT,apiToken:TOKEN,endpoint,maxBatchStatements:120,maxBatchBytes:4*1024*1024},databaseId,sleep:async()=>{}});
}
const appliedHttp=await run(drained,createPredictionBinding(adapterFor(TARGET)),new MemoryBucket());
assert.equal(appliedHttp.exit,0,JSON.stringify(appliedHttp.result));
assert.equal(fake.calls.filter(call=>call.write).every(call=>call.batch===false&&call.body.sql&&!call.body.batch),true);
const extras=Array.from({length:101},(_,index)=>"INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES ('film-"+String(index).padStart(3,'0')+"','h',1,1,NULL,NULL,'k','abc','{}');").join('\n');
sqliteFile(files[TARGET],extras);
const wideBucket=new MemoryBucket();
const kept={filmId:'kept',fingerprintHash:'h-kept',plotMechanics:[],moodLabels:[],execution:{},generatedAt:'2026-11-01T01:00:00.000Z',fingerprintSchemaVersion:1,fingerprintPromptVersion:1};
await put(wideBucket,'enrichment/films/kept/fingerprint.json',kept);
await put(wideBucket,'enrichment/films/kept/fingerprints/h-kept.json',kept);
const beforeWrites=fake.calls.length;
const pruned=await run(['--load','--confirm','load','--target','iptv'],createPredictionBinding(adapterFor(TARGET)),wideBucket);
assert.equal(pruned.exit,0,JSON.stringify(pruned.result));
const pruneWrites=fake.calls.slice(beforeWrites).filter(call=>call.write);
assert.ok(pruneWrites.length>0);
assert.equal(pruneWrites.every(call=>call.batch===false&&typeof call.body.sql==='string'&&!call.body.batch),true);
assert.equal(pruneWrites.every(call=>call.sql.split(';').every(statement=>(statement.match(/'film-/g)||[]).length<=80)),true);
assert.equal(sqliteFile(files[TARGET],'SELECT COUNT(*) FROM prediction_fingerprint;').trim(),'1');

const wideQueue={schemaVersion:3,pad:'a'.repeat(120000)};
const queueBucket=new MemoryBucket();
await put(queueBucket,'enrichment/prediction-queue.json',wideQueue);
const queueWritesAt=fake.calls.length;
const queued=await run(['--load','--confirm','load','--target','iptv'],createPredictionBinding(adapterFor(QUEUE_TARGET)),queueBucket);
assert.equal(queued.exit,0,JSON.stringify(queued.result));
const queueWrites=fake.calls.slice(queueWritesAt).filter(call=>call.write);
assert.equal(queueWrites.every(call=>call.batch===false&&call.body.sql&&!call.body.batch),true);
assert.equal(queueWrites.every(call=>call.sql.split(';').filter(Boolean).every(statement=>Buffer.byteLength(statement,'utf8')<=100*1024)),true);
const storedRows=sqliteFile(files[QUEUE_TARGET],'SELECT chunk_text FROM prediction_queue ORDER BY seq;').split('\n');
if(storedRows.at(-1)==='')storedRows.pop();
assert.equal(JSON.parse(storedRows.join('')).pad.length,120000);

await adapterFor(ROLL_TARGET).executeSql(['CREATE TABLE batch_ok (id INTEGER PRIMARY KEY)','INSERT INTO batch_ok (id) VALUES (1)']);
const rollAdapter=adapterFor(ROLL_TARGET);
await assert.rejects(rollAdapter.executeSql(['INSERT INTO batch_ok (id) VALUES (2)','INSERT INTO batch_missing (id) VALUES (1)']),error=>error.kind==='statement');
assert.equal(sqliteFile(files[ROLL_TARGET],'SELECT COUNT(*) FROM batch_ok;').trim(),'1');
const rolled=fake.calls.filter(call=>call.database===ROLL_TARGET&&/batch_missing/.test(call.sql));
assert.equal(rolled.length,1);
assert.equal(rolled[0].batch,false);
assert.match(rolled[0].sql,/VALUES \(2\)/);

fake.hooks.push(({write,phase})=>{if(write&&phase==='after')return 'drop';});
const dropBucket=new MemoryBucket();
await put(dropBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['drop']});
const dropWritesAt=fake.calls.filter(call=>call.database===DROP_TARGET&&call.write).length;
const dropped=await run(['--load','--confirm','load','--target','iptv'],createPredictionBinding(adapterFor(DROP_TARGET)),dropBucket);
assert.equal(dropped.result.reason,'write_uncertain');
assert.equal(dropped.result.writes,true);
assert.equal(dropped.result.writeState,'unknown');
assert.equal(fake.calls.filter(call=>call.database===DROP_TARGET&&call.write).length-dropWritesAt,1);
await fake.stop();

const fingerprintContent={filmId:'old',fingerprintSchemaVersion:1,plotMechanics:['heist'],moodLabels:['tense','dry'],execution:{pace:'medium'},confidence:'medium',risks:['late'],sourceBasis:'seen',sourceRefs:[],strengths:['plan']};
const fingerprintHash=await fingerprintContentHash(fingerprintContent);
const historical={...fingerprintContent,fingerprintHash,generatedAt:'2026-10-01T00:00:00.000Z',invalidatedAt:null};
assert.ok(await fingerprintPointerAgrees(historical));
assert.equal(await fingerprintPointerAgrees({...historical,plotMechanics:['chase']}),null);
const bodies=new MemoryBucket();
await put(bodies,'enrichment/films/old/fingerprint.json',historical);
const materialized=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),bodies);
assert.equal(materialized.exit,0,JSON.stringify(materialized.result));
assert.equal(materialized.result.writes,true);
assert.equal(materialized.result.created,1);
assert.equal(JSON.parse(bodies.objects.get('enrichment/films/old/fingerprints/'+fingerprintHash+'.json').text).fingerprintHash,fingerprintHash);
const repeated=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),bodies);
assert.equal(repeated.exit,0,JSON.stringify(repeated.result));
assert.equal(repeated.result.writes,false);
assert.equal(repeated.result.created,0);
const broken=new MemoryBucket();
await put(broken,'enrichment/films/old/fingerprint.json',historical);
await put(broken,'enrichment/films/other/fingerprint.json',{...historical,filmId:'other',plotMechanics:['chase']});
let brokenPuts=0;
const brokenPut=broken.put.bind(broken);
broken.put=async(...args)=>{brokenPuts++;return brokenPut(...args);};
const refusedBodies=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),broken);
assert.equal(refusedBodies.exit,3);
assert.equal(refusedBodies.result.reason,'prediction_domain_body_mismatch');
assert.equal(refusedBodies.result.writes,false);
assert.equal(brokenPuts,0);
assert.equal(broken.objects.has('enrichment/films/old/fingerprints/'+fingerprintHash+'.json'),false);
const clash=new MemoryBucket();
await put(clash,'enrichment/films/old/fingerprint.json',historical);
await put(clash,'enrichment/films/old/fingerprints/'+fingerprintHash+'.json',{...fingerprintContent,fingerprintHash:'nope'});
let clashPuts=0;
const clashPut=clash.put.bind(clash);
clash.put=async(...args)=>{clashPuts++;return clashPut(...args);};
const clashed=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),clash);
assert.equal(clashed.exit,3);
assert.equal(clashed.result.reason,'prediction_domain_body_mismatch');
assert.equal(clashPuts,0);
assert.equal(JSON.parse(clash.objects.get('enrichment/films/old/fingerprints/'+fingerprintHash+'.json').text).fingerprintHash,'nope');
const unconfirmed=await run(['--materialize-fingerprints','--target','iptv'],migrated('0006_metadata_cache'),new MemoryBucket());
assert.equal(unconfirmed.exit,2);
assert.equal(unconfirmed.result.reason,'confirm');
const missingWriter=await runPredictionDomainProduction({argv:argv('--materialize-fingerprints','--confirm','materialize','--target','iptv'),env:{},binding:migrated('0006_metadata_cache'),fetchImpl(){throw new Error('network');},now:()=>NOW});
assert.equal(missingWriter.exit,3);
assert.equal(missingWriter.result.reason,'writer_missing');
assert.equal(missingWriter.result.writes,false);
async function lostPut(bucket,which){
 const raw=bucket.put.bind(bucket);
 let puts=0;
 bucket.put=async(key,body,options)=>{
  puts++;
  const saved=await raw(key,body,options);
  if(puts===which)throw new Error('socket hang up');
  return saved;
 };
 return {puts:()=>puts};
}
const lostFirst=new MemoryBucket();
await put(lostFirst,'enrichment/films/old/fingerprint.json',historical);
const firstPuts=await lostPut(lostFirst,1);
const uncertainFirst=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),lostFirst);
assert.equal(uncertainFirst.exit,3);
assert.equal(uncertainFirst.result.reason,'write_uncertain');
assert.equal(uncertainFirst.result.writes,true);
assert.equal(uncertainFirst.result.writeState,'unknown');
assert.equal(uncertainFirst.result.committedUnits,undefined);
assert.equal(firstPuts.puts(),1);
assert.equal(JSON.parse(lostFirst.objects.get('enrichment/films/old/fingerprints/'+fingerprintHash+'.json').text).fingerprintHash,fingerprintHash);
const nextContent={...fingerprintContent,filmId:'next',plotMechanics:['chase']};
const nextHash=await fingerprintContentHash(nextContent);
const nextPointer={...nextContent,fingerprintHash:nextHash,generatedAt:'2026-10-01T00:00:00.000Z',invalidatedAt:null};
const lostLater=new MemoryBucket();
await put(lostLater,'enrichment/films/next/fingerprint.json',nextPointer);
await put(lostLater,'enrichment/films/old/fingerprint.json',historical);
const laterPuts=await lostPut(lostLater,2);
const uncertainLater=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),lostLater);
assert.equal(uncertainLater.exit,3);
assert.equal(uncertainLater.result.reason,'write_uncertain');
assert.equal(uncertainLater.result.writes,true);
assert.equal(uncertainLater.result.writeState,'unknown');
assert.equal(uncertainLater.result.committedUnits,1);
assert.equal(laterPuts.puts(),2);
assert.ok(lostLater.objects.has('enrichment/films/next/fingerprints/'+nextHash+'.json'));
assert.ok(lostLater.objects.has('enrichment/films/old/fingerprints/'+fingerprintHash+'.json'));
const headOnly=new MemoryBucket();
await put(headOnly,'enrichment/films/old/fingerprint.json',historical);
headOnly.putIfAbsent=async()=>{const error=new Error('head down');error.phase='before-put';throw error;};
const headFailed=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),headOnly);
assert.equal(headFailed.exit,1);
assert.equal(headFailed.result.reason,'failed');
assert.equal(headFailed.result.writes,false);
assert.equal(headFailed.result.writeState,'none');
assert.equal(headOnly.objects.has('enrichment/films/old/fingerprints/'+fingerprintHash+'.json'),false);
let headCalls=0;
const headAfter=new MemoryBucket();
await put(headAfter,'enrichment/films/next/fingerprint.json',nextPointer);
await put(headAfter,'enrichment/films/old/fingerprint.json',historical);
headAfter.putIfAbsent=async(key,text)=>{
 headCalls++;
 if(headCalls>1){const error=new Error('head down');error.phase='before-put';throw error;}
 headAfter.objects.set(key,{text,customMetadata:{}});
 return {etag:'1'};
};
const headPartial=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],migrated('0006_metadata_cache'),headAfter);
assert.equal(headPartial.exit,1);
assert.equal(headPartial.result.reason,'failed');
assert.equal(headPartial.result.writes,true);
assert.equal(headPartial.result.writeState,'partial');
assert.equal(headPartial.result.committedUnits,1);
assert.equal(headCalls,2);
function headerValue(headers,name){
 if(!headers)return undefined;
 if(typeof headers.get==='function')return headers.get(name);
 const found=Object.keys(headers).find(key=>key.toLowerCase()===name);
 return found?headers[found]:undefined;
}
function materializeFetch(objects,{fail}={}){
 const calls={d1:0,put:0,head:0};
 const fetchImpl=async(url,init={})=>{
  const target=new URL(url);
  if(target.hostname.includes('api.cloudflare.com')||target.pathname.includes('/d1/')){calls.d1++;throw new Error('d1');}
  const method=init.method||'GET';
  const parts=target.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const key=parts.slice(1).join('/')||null;
  if(parts[0]!=='iptv')return new Response('no',{status:404});
  if(method==='GET'&&key==null){
   const prefix=target.searchParams.get('prefix')||'';
   const keys=[...objects.keys()].filter(name=>name.startsWith(prefix)).sort();
   const xml='<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>'+keys.map(name=>'<Contents><Key>'+name+'</Key><Size>'+Buffer.byteLength(objects.get(name))+'</Size><ETag>&quot;etag&quot;</ETag></Contents>').join('')+'</ListBucketResult>';
   return new Response(xml,{status:200,headers:{'content-type':'application/xml'}});
  }
  if(method==='HEAD'&&fail==='head'&&key&&key.includes('/fingerprints/')){calls.head++;throw new Error('head down');}
  if(method==='HEAD'||method==='GET'){
   if(method==='HEAD')calls.head++;
   const body=key==null?null:objects.get(key);
   if(body==null)return new Response(null,{status:404});
   return new Response(method==='HEAD'?null:body,{status:200,headers:{etag:'"etag"','content-length':String(Buffer.byteLength(body)),'content-type':'application/json'}});
  }
  if(method==='PUT'){
   calls.put++;
   if(fail==='put')throw new Error('socket hang up');
   if(headerValue(init.headers,'if-none-match')==='*'&&objects.has(key))return new Response(null,{status:412});
   const text=Buffer.isBuffer(init.body)?init.body.toString('utf8'):String(init.body);
   objects.set(key,text);
   return new Response(null,{status:200,headers:{etag:'"created"','content-length':'0'}});
  }
  return new Response('no',{status:405});
 };
 return {fetchImpl,calls};
}
const liveObjects=new Map([['enrichment/films/old/fingerprint.json',JSON.stringify(historical)]]);
const live=materializeFetch(liveObjects);
const createdLive=await runPredictionDomainProduction({argv:argv('--materialize-fingerprints','--confirm','materialize','--target','iptv'),env:installEnv('iptv'),fetchImpl:live.fetchImpl,now:()=>NOW});
assert.equal(createdLive.exit,0,JSON.stringify(createdLive.result));
assert.equal(createdLive.result.writes,true);
assert.equal(createdLive.result.created,1);
assert.equal(live.calls.d1,0);
assert.equal(live.calls.put,1);
assert.equal(JSON.parse(liveObjects.get('enrichment/films/old/fingerprints/'+fingerprintHash+'.json')).fingerprintHash,fingerprintHash);
let refusedFetches=0;
const refusedFetch=()=>{refusedFetches++;throw new Error('network');};
const wrongMaterializeBucket=await runPredictionDomainProduction({argv:argv('--materialize-fingerprints','--confirm','materialize','--target','iptv'),env:installEnv('other-bucket'),fetchImpl:refusedFetch,now:()=>NOW});
assert.equal(wrongMaterializeBucket.exit,3);
assert.equal(wrongMaterializeBucket.result.reason,'bucket_identity');
assert.equal(wrongMaterializeBucket.result.writes,false);
const wrongMaterializeEndpoint=await runPredictionDomainProduction({argv:argv('--materialize-fingerprints','--confirm','materialize','--target','iptv'),env:installEnv('iptv','https://example.invalid'),fetchImpl:refusedFetch,now:()=>NOW});
assert.equal(wrongMaterializeEndpoint.exit,3);
assert.equal(wrongMaterializeEndpoint.result.reason,'endpoint_refused');
assert.equal(refusedFetches,0);
const lostRemote=materializeFetch(new Map([['enrichment/films/old/fingerprint.json',JSON.stringify(historical)]]),{fail:'put'});
const uncertainRemote=await runPredictionDomainProduction({argv:argv('--materialize-fingerprints','--confirm','materialize','--target','iptv'),env:installEnv('iptv'),fetchImpl:lostRemote.fetchImpl,now:()=>NOW});
assert.equal(uncertainRemote.exit,3);
assert.equal(uncertainRemote.result.reason,'write_uncertain');
assert.equal(uncertainRemote.result.writes,true);
assert.equal(uncertainRemote.result.writeState,'unknown');
assert.equal(lostRemote.calls.put,1);
assert.equal(lostRemote.calls.d1,0);
const headRemote=materializeFetch(new Map([['enrichment/films/old/fingerprint.json',JSON.stringify(historical)]]),{fail:'head'});
const headRemoteResult=await runPredictionDomainProduction({argv:argv('--materialize-fingerprints','--confirm','materialize','--target','iptv'),env:installEnv('iptv'),fetchImpl:headRemote.fetchImpl,now:()=>NOW});
assert.equal(headRemoteResult.exit,1);
assert.equal(headRemoteResult.result.reason,'failed');
assert.equal(headRemoteResult.result.writes,false);
assert.equal(headRemoteResult.result.writeState,'none');
assert.equal(headRemote.calls.put,0);
assert.equal(headRemote.calls.d1,0);

console.log('prediction domain production entry: confirm, lease, fence, parity and revert fail closed without a network call');
