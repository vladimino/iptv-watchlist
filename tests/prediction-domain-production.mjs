// ADR 0078. The production entry stays read-only unless a command names iptv and its own confirm.
// These cases inject a local binding and an in-memory bucket. They do not call the network.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runPredictionDomainProduction} from '../scripts/prediction-domain-production.mjs';
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
const applied=await run(['--apply','--confirm','apply','--target','iptv'],v6);
assert.equal(applied.exit,0,JSON.stringify(applied.result));
assert.equal(applied.result.writes,true);
assert.equal(applied.result.schemaVersion,7);
assert.equal(applied.result.mode,'r2');
assert.equal(applied.result.generation,0);
assert.equal(one(v6,'SELECT COUNT(*) FROM film'),0);
const again=await run(['--apply','--confirm','apply','--target','iptv'],v6);
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
assert.match(claimed.sql('SELECT document_json FROM prediction_queue')[0].document_json,/caught/);

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
assert.match(raced.sql('SELECT document_json FROM prediction_queue')[0].document_json,/retry/);

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
assert.match(drift.sql('SELECT document_json FROM prediction_queue')[0].document_json,/"a"/);

const body={filmId:'solo',fingerprintHash:'print-2',plotMechanics:[],moodLabels:[],execution:{}};
const record={...body,generatedAt:'2026-11-01T04:00:00.000Z',invalidatedAt:null,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,produced:'generated',previous:null};
const missing=migrated('0007_prediction_authority');
const missingBucket=new MemoryBucket();
await put(missingBucket,'enrichment/films/solo/fingerprint.json',record);
await put(missingBucket,'enrichment/films/solo/fingerprints/print-2.json',body);
const imported=await run(['--load','--confirm','load','--target','iptv'],missing,missingBucket);
assert.equal(imported.exit,0,JSON.stringify(imported.result));
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

console.log('prediction domain production entry: confirm, lease, fence, parity and revert fail closed without a network call');
