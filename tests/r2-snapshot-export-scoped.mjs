// AIR-554 (owner GO of 22 Nov 2026): the scoped cut `--scope prediction-aux` of scripts/r2-snapshot-export.mjs, on a fake S3 bucket over loopback. It proves what the mode claims and what it does not:
// the scope is exactly the legacy auxiliary state the importer consumes, an unrelated writer does not change the verdict, any added, removed or changed object of the scope or its own fence does,
// the whole-bucket mode keeps its old NO-GO, a write that lands after the closing inventory is NOT seen by one cut (it is seen by the next one), and the converter and the checks refuse a tampered scope.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ExportError} from '../scripts/migration-export.mjs';
import {NoGo,STATUS_CONSISTENT,STATUS_NO_GO,exportProductionSnapshot,plan,readCredentials,verifyProductionSnapshot} from '../scripts/r2-snapshot-export.mjs';
import {PREDICTION_AUX_SCOPE,STAGE_KEY,OUTBOX_KEY,describeScope,inAuxScope,scopeDigest} from '../scripts/prediction-aux-scope.mjs';
import {auxConsumableKey,auxExportFamily} from '../scripts/prediction-aux-d1-import.mjs';
import {convertSnapshot} from '../scripts/prediction-aux-export-convert.mjs';
import {fakeBucket,envFor} from './r2-fake-bucket-lib.mjs';

const json=value=>JSON.stringify(value);
const noSleep=async()=>{};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'aux-scope-'));
const made=[];process.on('exit',()=>{for(const dir of made)try{fs.rmSync(dir,{recursive:true,force:true});}catch{/* best effort */}});
const dir=()=>{const d=tmp();made.push(d);return d;};
const SOURCE_A='enrichment/sources/run-a.json',SOURCE_B='enrichment/sources/run-b.json',MANIFEST_A='enrichment/batch-manifest/run-a.json';
const STOP_A='enrichment/stop-events/skipped-run-a.json',START_A='enrichment/start-events/run-a.json';
const RUNNER='enrichment/runner-lease.json',WRITER='enrichment/writer-lease.json';
const aux=()=>({
 [STAGE_KEY]:json({items:[]}),[OUTBOX_KEY]:json({pending:{}}),
 [SOURCE_A]:json({tmdb_1:{title:'A'}}),[SOURCE_B]:json({tmdb_2:{title:'B'}}),[MANIFEST_A]:json({runId:'run-a',films:[]}),
 [STOP_A]:json({id:'x'}),[START_A]:json({id:'y'}),
});
const unrelated=()=>({
 'sync.json':json({updatedAt:'2026-11-22T10:00:00.000Z'}),'epg/published-generation.json':json({programmeRunId:'p-1'}),'epg/resolver-lease.json':json({id:'l-1'}),'epg/resolver-continuation.json':json({at:'t',hopId:'h'}),
 'enrichment/profile/current.json':json({version:3}),'enrichment/latest-run.json':json({runId:'r'}),'monitor/state.json':json({tick:1}),
 'epg/discovery-archive/v1/segment-1.json':json({n:1}),'letterboxd/diary/state.json':json({n:1}),'started/heat.json':json({started:true}),'watchlist.json':json({films:[]}),
});
const fence=()=>({[RUNNER]:json({id:'runner-1'}),[WRITER]:json({id:'writer-1'})});
const world=(extra={},{pageSize=3}={})=>fakeBucket({...aux(),...unrelated(),...fence(),...extra},{pageSize});
async function open(bucket){const endpoint=await bucket.start();return readCredentials(envFor(endpoint));}
const scoped=(credentials,directory,extra={})=>exportProductionSnapshot({directory,credentials,sleep:noSleep,scope:'prediction-aux',...extra});
async function noGo(promise,reason){let caught=null;await assert.rejects(promise,error=>{caught=error;return error instanceof NoGo;});assert.ok(caught.reasons.includes(reason),JSON.stringify(caught.reasons));return caught;}
const manifestOf=directory=>JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
const auxKeys=Object.keys(aux()).sort();

// ---- 1. the scope is exactly the legacy auxiliary state the importer consumes (lossless coverage) ----
{
 const universe=[STAGE_KEY,OUTBOX_KEY,'enrichment/sources/r1.json','enrichment/batch-manifest/r1.json','enrichment/stop-events/r1.json','enrichment/stop-events/skipped-r1.json','enrichment/start-events/r1.json','enrichment/start-events/skipped-r1.json'];
 for(const key of universe){assert.ok(inAuxScope(key),key);assert.ok(auxConsumableKey(key),key);assert.ok(auxExportFamily(key),key);}
 // every key the importer assigns to a family lies inside the scope, and the scope holds no other key
 for(const key of [...universe,'enrichment/sources/','enrichment/sources/a/b.json','enrichment/latest-run.json','enrichment/profile/current.json','epg/x.json','sync.json','enrichment/batch-stage.json.bak','enrichment/event-outbox.json.1']){
  assert.equal(inAuxScope(key),Boolean(auxExportFamily(key))&&(key===STAGE_KEY||key===OUTBOX_KEY||(key.length>'enrichment/sources/'.length&&PREDICTION_AUX_SCOPE.prefixes.some(prefix=>key.startsWith(prefix)))),key);
 }
 // the Worker's own gate and the scope name the same keys
 const worker=fs.readFileSync('src/enrichment.js','utf8');
 assert.match(worker,/const START_EVENT_PREFIX=ENRICHMENT_KEY\+'start-events\/'/);assert.match(worker,/const STOP_EVENT_PREFIX=ENRICHMENT_KEY\+'stop-events\/'/);
 assert.match(worker,/const BATCH_STAGE_KEY=ENRICHMENT_KEY\+'batch-stage.json'/);assert.match(worker,/const EVENT_OUTBOX_KEY=ENRICHMENT_KEY\+'event-outbox.json'/);
 const gate=worker.slice(worker.indexOf('const auxR2Family='),worker.indexOf('\n',worker.indexOf('const auxR2Family=')));
 for(const part of ['BATCH_STAGE_KEY','EVENT_OUTBOX_KEY',"ENRICHMENT_KEY+'sources/'","ENRICHMENT_KEY+'batch-manifest/'",'START_EVENT_PREFIX','STOP_EVENT_PREFIX'])assert.ok(gate.includes(part),part);
 assert.deepEqual([...PREDICTION_AUX_SCOPE.singletons].sort(),[STAGE_KEY,OUTBOX_KEY]);
 assert.equal(PREDICTION_AUX_SCOPE.prefixes.length,4);
 // the fence holds the batch runner's and writer's leases and none of the EPG or Discovery coordination keys
 assert.deepEqual([...PREDICTION_AUX_SCOPE.fenceKeys].sort(),[RUNNER,WRITER]);
 assert.equal(PREDICTION_AUX_SCOPE.fenceKeys.some(key=>/^epg\//.test(key)||key==='sync.json'),false);
 // digests: a known scope has one digest, anything else is unsupported
 assert.equal(describeScope(PREDICTION_AUX_SCOPE).digest,scopeDigest(PREDICTION_AUX_SCOPE));
 assert.equal(describeScope({...PREDICTION_AUX_SCOPE,prefixes:[...PREDICTION_AUX_SCOPE.prefixes,'epg/']}),null);
 assert.equal(describeScope({...PREDICTION_AUX_SCOPE,fenceKeys:['epg/resolver-lease.json']}),null);
 assert.equal(describeScope({kind:'other'}),null);assert.equal(describeScope('x'),null);
 assert.equal(describeScope(undefined).kind,'full_bucket');
}

// ---- 2. the plan names the scope, sends nothing, reads no secret ----
{
 const planned=plan({directory:'/private/aux',scope:'prediction-aux',env:{}});
 assert.equal(planned.network,false);assert.equal(planned.credentialsRead,false);
 assert.equal(planned.scope.kind,'prediction_aux');assert.deepEqual(planned.scope.prefixes,[...PREDICTION_AUX_SCOPE.prefixes]);assert.deepEqual(planned.fenceKeys,[...PREDICTION_AUX_SCOPE.fenceKeys]);
 assert.equal(plan({directory:'/private/aux',env:{}}).scope.kind,'full_bucket','the default plan is the whole bucket');
 assert.throws(()=>plan({directory:'/private/aux',scope:'full_bucket',env:{}}),error=>error instanceof ExportError&&error.kind==='configuration');
 assert.throws(()=>plan({directory:'/private/aux',scope:'nope',env:{}}),error=>error instanceof ExportError&&error.kind==='configuration');
 const cli=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--plan','--output',dir(),'--scope','prediction-aux'],{encoding:'utf8'});assert.equal(cli.status,0);assert.equal(JSON.parse(cli.stdout).scope.kind,'prediction_aux');
 const bad=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--plan','--output',dir(),'--scope','nope'],{encoding:'utf8'});assert.notEqual(bad.status,0);
}

// ---- 3. a scoped cut over a bucket full of unrelated objects: only the scope is listed, read and recorded ----
{
 const bucket=world();const credentials=await open(bucket);const directory=dir();
 const result=await scoped(credentials,directory);
 assert.equal(result.status,STATUS_CONSISTENT);assert.equal(result.scope.kind,'prediction_aux');assert.equal(result.objects,auxKeys.length);
 const manifest=manifestOf(directory);
 assert.deepEqual(manifest.objects.map(entry=>entry.key).sort(),auxKeys,'the manifest holds exactly the auxiliary objects');
 assert.deepEqual(manifest.scope,JSON.parse(JSON.stringify(PREDICTION_AUX_SCOPE)));assert.equal(manifest.baselineIdentity,null);assert.match(manifest.consistencyNote,/Scoped cut/);
 assert.deepEqual(manifest.fence.keys.map(item=>item.key).sort(),[RUNNER,WRITER]);assert.equal(manifest.fence.ok,true);
 // only scope prefixes were listed, and no object outside the scope and its fence was ever touched
 assert.deepEqual([...new Set(bucket.calls.listPrefixes)].sort(),[...PREDICTION_AUX_SCOPE.prefixes].sort());assert.equal(bucket.calls.listPrefixes.includes(''),false);
 const allowed=new Set([...auxKeys,RUNNER,WRITER,STAGE_KEY,OUTBOX_KEY]);
 assert.ok(bucket.calls.touched.every(key=>allowed.has(key)),'nothing outside the scope was read: '+JSON.stringify(bucket.calls.touched.filter(key=>!allowed.has(key))));
 assert.equal(bucket.calls.writes,0);
 // pagination: every prefix is listed to its end (page size 3, sources and others over several pages)
 assert.ok(bucket.calls.list>=PREDICTION_AUX_SCOPE.prefixes.length*2,'opening and closing inventories of every prefix');
 const verified=await verifyProductionSnapshot(directory);assert.equal(verified.status,STATUS_CONSISTENT);assert.equal(verified.scope.kind,'prediction_aux');
 // the converter takes it whole: nothing skipped, the report carries the proof kind
 const out=dir();fs.rmSync(out,{recursive:true,force:true});
 const report=await convertSnapshot({snapshot:directory,output:out});
 assert.equal(report.snapshot.scope.kind,'prediction_aux');assert.equal(report.snapshot.scope.digest,scopeDigest(PREDICTION_AUX_SCOPE));assert.equal(report.converted.objects,auxKeys.length);assert.equal(report.converted.skippedObjects,0);
 await bucket.stop();
}

// ---- 4. the original problem: an unrelated writer. Whole-bucket mode stays NO-GO; the scoped cut stays valid ----
{
 const writer=bucket=>{let armed=true;bucket.hooks.push(({method,key,put})=>{
  // one object of EVERY unrelated writer changes while the export runs: the hourly tick (monitor), Discovery, Letterboxd, EPG (lease and generation) and sync
  if(armed&&method==='GET'&&key!==null){armed=false;put('monitor/state.json',json({tick:2}));put('epg/discovery-archive/v1/segment-2.json',json({n:2}));put('letterboxd/diary/state.json',json({n:2}));put('epg/resolver-lease.json',json({id:'l-2'}));put('epg/published-generation.json',json({programmeRunId:'p-2'}));put('sync.json',json({updatedAt:'2026-11-22T10:01:00.000Z'}));}
 });};
 {
  const bucket=world();writer(bucket);const credentials=await open(bucket);
  const result=await scoped(credentials,dir());
  assert.equal(result.status,STATUS_CONSISTENT,'unrelated writers do not change the verdict of a scoped cut');
  await bucket.stop();
 }
 {
  const bucket=world();writer(bucket);const credentials=await open(bucket);
  // unchanged whole-bucket semantics: the very same writer makes the bucket-wide proof fail (the changed objects are caught before or after their download)
  let caught=null;await assert.rejects(exportProductionSnapshot({directory:dir(),credentials,sleep:noSleep}),error=>{caught=error;return error instanceof NoGo;});
  assert.ok(caught.reasons.length>0&&caught.reasons.every(reason=>['source_changed','inventory_changed','fence_changed','deletion_observed'].includes(reason)),JSON.stringify(caught.reasons));
  await bucket.stop();
 }
}

// ---- 5. any change of the scope itself is a NO-GO: add, change, delete, a singleton appearing or changing ----
{
 const attempt=async(label,reason,mutate,{initial={}}={})=>{
  const bucket=world(initial);let armed=true;
  bucket.hooks.push(({method,key,put,items})=>{if(armed&&method==='GET'&&key===SOURCE_A){armed=false;mutate({put,items});}});
  const credentials=await open(bucket);
  const caught=await noGo(scoped(credentials,dir()),reason);
  await bucket.stop();
  return {label,caught};
 };
 await attempt('a record added under an event prefix','inventory_changed',({put})=>put('enrichment/stop-events/skipped-run-z.json',json({id:'z'})));
 await attempt('a record added under the source prefix','inventory_changed',({put})=>put('enrichment/sources/run-z.json',json({tmdb_3:{}})));
 await attempt('a record added under the manifest prefix','inventory_changed',({put})=>put('enrichment/batch-manifest/run-z.json',json({runId:'z'})));
 // objects the cut already downloaded (listing order: manifests, the two singletons, then the sources of run-a): a change is seen by the closing inventory
 await attempt('a downloaded manifest rewritten (new ETag)','inventory_changed',({put})=>put(MANIFEST_A,json({runId:'run-a',films:['changed']})));
 await attempt('a downloaded manifest deleted','inventory_changed',({items})=>items.delete(MANIFEST_A));
 await attempt('the outbox index rewritten after its download','inventory_changed',({put})=>put(OUTBOX_KEY,json({pending:{k:{}}})));
 await attempt('the held stage rewritten after its download','inventory_changed',({put})=>put(STAGE_KEY,json({items:[{filmId:'f'}]})));
 // objects not downloaded yet: the conditional read of the listed version refuses them (`source_changed`)
 await attempt('a source rewritten before its download','source_changed',({put})=>put(SOURCE_B,json({tmdb_2:{title:'changed'}})));
 await attempt('an auxiliary object deleted before its download','source_changed',({items})=>items.delete(START_A));
 {
  // a singleton absent at the opening that appears during the cut
  const bucket=world();bucket.items.delete(STAGE_KEY);let armed=true;
  bucket.hooks.push(({method,key,put})=>{if(armed&&method==='GET'&&key===SOURCE_A){armed=false;put(STAGE_KEY,json({items:[]}));}});
  const credentials=await open(bucket);
  const caught=await noGo(scoped(credentials,dir()),'inventory_changed');assert.deepEqual(caught.details.changes.map(item=>item.key+':'+item.reason),[STAGE_KEY+':added_after']);
  await bucket.stop();
 }
 {
  // the same object rewritten between its conditional reads: the ETag drift is a NO-GO (`source_changed`)
  const bucket=world();let armed=true;
  bucket.hooks.push(({method,key,put})=>{if(armed&&method==='GET'&&key===SOURCE_A){armed=false;put(SOURCE_A,json({tmdb_1:{title:'rewritten'}}));}});
  const credentials=await open(bucket);
  await noGo(scoped(credentials,dir()),'source_changed');
  await bucket.stop();
 }
 {
  // the fence: a lease of THIS domain changes (inside the cut) or appears
  const bucket=world();let armed=true;
  bucket.hooks.push(({method,key,put})=>{if(armed&&method==='GET'&&key===SOURCE_A){armed=false;put(RUNNER,json({id:'runner-2'}));}});
  const credentials=await open(bucket);
  const caught=await noGo(scoped(credentials,dir()),'fence_changed');assert.equal(caught.details.fence.keys.find(item=>item.key===RUNNER).status,'changed');assert.equal(caught.reasons.includes('inventory_changed'),false);
  await bucket.stop();
 }
 {
  const bucket=world();bucket.items.delete(WRITER);let armed=true;
  bucket.hooks.push(({method,key,put})=>{if(armed&&method==='GET'&&key===SOURCE_A){armed=false;put(WRITER,json({id:'writer-2'}));}});
  const credentials=await open(bucket);
  const caught=await noGo(scoped(credentials,dir()),'fence_changed');assert.equal(caught.details.fence.keys.find(item=>item.key===WRITER).status,'created');
  await bucket.stop();
 }
}

// ---- 6. the documented boundary: a PUT that lands AFTER the closing inventory is not seen by that cut, and is seen by the next one ----
{
 const bucket=world();const credentials=await open(bucket);
 let lists=0,armed=false;const total=PREDICTION_AUX_SCOPE.prefixes.length;
 // the closing inventory is the second round of prefix listings; the late PUT lands on the first HEAD that follows it (the fence read)
 bucket.hooks.push(({method,key,put})=>{
  if(method==='GET'&&key===null&&++lists===total*2)armed=true;
  else if(armed&&method==='HEAD'&&key===RUNNER){armed=false;put(SOURCE_B,json({tmdb_2:{title:'late'}}));}
 });
 const firstDir=dir(),secondDir=dir();
 const first=await scoped(credentials,firstDir);
 assert.equal(first.status,STATUS_CONSISTENT,'one cut cannot see a write after its own closing inventory: this is the residual of ADR 0196, not a claim of the exporter');
 const second=await scoped(credentials,secondDir);assert.equal(second.status,STATUS_CONSISTENT);
 const entry=(directory,key)=>manifestOf(directory).objects.find(item=>item.key===key);
 // the two cuts disagree on the late object (same key, another ETag): the operator refuses a flip on exactly this difference (`listing_changed`)
 assert.notEqual(entry(firstDir,SOURCE_B).metadata.etag,entry(secondDir,SOURCE_B).metadata.etag);
 assert.notEqual(entry(firstDir,SOURCE_B).sha256,entry(secondDir,SOURCE_B).sha256);
 assert.equal(entry(firstDir,SOURCE_A).metadata.etag,entry(secondDir,SOURCE_A).metadata.etag,'objects nobody wrote are identical in both cuts');
 await bucket.stop();
}

// ---- 7. output directories, resume, verification and tampering ----
{
 const bucket=world();const credentials=await open(bucket);
 // a directory that holds one scope is never reused for the other
 const mixed=dir();
 await exportProductionSnapshot({directory:mixed,credentials,sleep:noSleep});
 await assert.rejects(scoped(credentials,mixed),error=>error instanceof ExportError&&error.kind==='configuration'&&/another export scope/.test(error.message));
 const onlyScoped=dir();await scoped(credentials,onlyScoped);
 await assert.rejects(exportProductionSnapshot({directory:onlyScoped,credentials,sleep:noSleep}),error=>error instanceof ExportError&&error.kind==='configuration');
 // resume of the same scope reuses verified checkpoints
 const resumeDir=dir();await scoped(credentials,resumeDir);fs.rmSync(path.join(resumeDir,'manifest.json'));
 const resumed=await scoped(credentials,resumeDir);assert.equal(resumed.resumed,auxKeys.length);assert.equal(resumed.status,STATUS_CONSISTENT);
 // an unknown scope is a configuration error before any request
 await assert.rejects(exportProductionSnapshot({directory:dir(),credentials,sleep:noSleep,scope:'everything'}),error=>error instanceof ExportError&&error.kind==='configuration');
 await assert.rejects(exportProductionSnapshot({directory:dir(),credentials,sleep:noSleep,scope:'full_bucket'}),error=>error instanceof ExportError&&error.kind==='configuration');
 // tampering with the recorded scope is refused by verification and by the converter
 const tamper=(mutate)=>{const copy=dir();fs.cpSync(onlyScoped,copy,{recursive:true});const manifest=manifestOf(copy);mutate(manifest);fs.writeFileSync(path.join(copy,'manifest.json'),JSON.stringify(manifest,null,2));return copy;};
 const widened=tamper(manifest=>{manifest.scope.prefixes.push('epg/');});
 await assert.rejects(verifyProductionSnapshot(widened),error=>error instanceof ExportError&&/unsupported export scope/.test(error.message));
 const fenceSwapped=tamper(manifest=>{manifest.fence.keys=manifest.fence.keys.map(item=>({...item,key:item.key==='enrichment/runner-lease.json'?'epg/resolver-lease.json':item.key}));});
 await assert.rejects(verifyProductionSnapshot(fenceSwapped),error=>error instanceof ExportError&&/fence keys differ/.test(error.message));
 // a whole-bucket snapshot relabelled as a scoped one holds objects outside the scope: refused
 const wholeDir=dir();await exportProductionSnapshot({directory:wholeDir,credentials,sleep:noSleep});
 const relabelled=dir();fs.cpSync(wholeDir,relabelled,{recursive:true});
 {const manifest=manifestOf(relabelled);manifest.scope=JSON.parse(JSON.stringify(PREDICTION_AUX_SCOPE));manifest.fence.keys=manifest.fence.keys.filter(item=>PREDICTION_AUX_SCOPE.fenceKeys.includes(item.key));fs.writeFileSync(path.join(relabelled,'manifest.json'),JSON.stringify(manifest,null,2));}
 await assert.rejects(verifyProductionSnapshot(relabelled),error=>error instanceof ExportError&&/outside its scope/.test(error.message));
 const unknown=tamper(manifest=>{manifest.scope={kind:'something_else',version:1};});
 await assert.rejects(verifyProductionSnapshot(unknown),error=>error instanceof ExportError);
 const out=dir();fs.rmSync(out,{recursive:true,force:true});
 await assert.rejects(convertSnapshot({snapshot:widened,output:out}),error=>error.code==='snapshot_not_verified'||error.name==='Refusal');
 assert.equal(fs.existsSync(out),false,'nothing left behind');
 // the CLI refuses a --verify that names another scope than the snapshot carries
 const mismatch=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--output',mixed,'--verify','--scope','prediction-aux'],{encoding:'utf8'});assert.notEqual(mismatch.status,0);
 const same=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--output',onlyScoped,'--verify','--scope','prediction-aux'],{encoding:'utf8'});assert.equal(same.status,0);assert.equal(JSON.parse(same.stdout).scope.kind,'prediction_aux');
 await bucket.stop();
}

// ---- 7b. a server that answers a prefixed listing with keys outside the prefix is a protocol error, never a wider cut ----
{
 const bucket=world();bucket.options.ignorePrefix=true;const credentials=await open(bucket);
 await assert.rejects(scoped(credentials,dir()),error=>error instanceof ExportError&&error.kind==='protocol');
 await bucket.stop();
}

// ---- 8. old whole-bucket snapshots keep working (no scope in the manifest) ----
{
 const bucket=world();const credentials=await open(bucket);const directory=dir();
 const result=await exportProductionSnapshot({directory,credentials,sleep:noSleep});
 assert.equal(result.status,STATUS_CONSISTENT);assert.equal(manifestOf(directory).scope,undefined,'the whole-bucket manifest is unchanged');
 const verified=await verifyProductionSnapshot(directory);assert.equal(verified.scope.kind,'full_bucket');
 const out=dir();fs.rmSync(out,{recursive:true,force:true});
 const report=await convertSnapshot({snapshot:directory,output:out});
 assert.equal(report.snapshot.scope.kind,'full_bucket');assert.equal(report.converted.objects,auxKeys.length);assert.ok(report.converted.skippedObjects>0,'the whole-bucket conversion still skips unrelated objects');
 await bucket.stop();
}
void STATUS_NO_GO;
console.log('R2 snapshot export, prediction-aux scope: coverage, plan, scoped cut, unrelated writers, scope changes, late write boundary, resume, tampering and whole-bucket compatibility passed');
