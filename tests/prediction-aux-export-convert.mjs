// AIR-554 (ADR 0196 handoff): the converter from the verified production R2 snapshot to the importer input, end to end and offline. The snapshot is produced by the REAL exporter against a fake S3 bucket
// (tests/r2-fake-bucket-lib.mjs), the four families come from the REAL Worker running its legacy R2 path, and the converted tree goes through the importer's report, digest, preflight, sql and verify.
// No production call, no credential, no Scheduled Task, no model; every directory is a temporary one outside the repository.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {flowWorld,sql,migrated,labelStarts} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {fakeBucket,envFor} from './r2-fake-bucket-lib.mjs';
import {exportProductionSnapshot,readCredentials,FENCE_KEYS} from '../scripts/r2-snapshot-export.mjs';
import {buildPlan,planReport,planSql,planVerifySql,planRunPreflightSql,readExport,auxExportFamily} from '../scripts/prediction-aux-d1-import.mjs';
import {convertSnapshot,Refusal,safeSegments} from '../scripts/prediction-aux-export-convert.mjs';
import * as Aux from '../src/prediction-aux-d1.js';
labelStarts();

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'aux-convert-'));
const noSleep=async()=>{};
const refusal=async(promise,code)=>{try{await promise;}catch(error){assert.ok(error instanceof Refusal,'a typed refusal, got '+error);assert.equal(error.code,code,JSON.stringify(error.detail));return error;}assert.fail('expected the refusal '+code);};
const applySql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+text+'COMMIT;',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr.trim());};
const runImporter=(...args)=>spawnSync(process.execPath,['scripts/prediction-aux-d1-import.mjs',...args],{encoding:'utf8',maxBuffer:1<<28});

// The four families as the real legacy Worker writes them: a start, a held stage, a skipped request, the completion (a delivered stop record).
const w=await flowWorld({films:8,aux:'r2'});
const {start}=await w.reconcileAndStart({manifestSize:4});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
const runId=start.data.runId;
await w.pair(runId);
const held=start.data.films.slice(1,3).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
assert.equal((await w.api('batch/hold',{runId,epoch:start.data.lease.epoch,items:held})).status,200);
const rival=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',taskId:'task15',capacity:{remainingPercent:100}});assert.equal(rival.data.status,'already_running');
assert.equal((await w.api('complete',{runId,reason:'external_termination'})).status,200);
const legacy=Object.fromEntries([...w.records.entries()].filter(([key])=>auxExportFamily(key)));
assert.ok(legacy['enrichment/batch-stage.json']&&legacy['enrichment/sources/'+runId+'.json']&&legacy['enrichment/batch-manifest/'+runId+'.json'],'the legacy path wrote the three run families');
assert.ok(Object.keys(legacy).some(key=>key.startsWith('enrichment/stop-events/skipped-')),'and the skipped record');

const json=value=>JSON.stringify(value);
// What the bucket holds: the fence and identity keys the exporter needs, noise the converter must drop, the families, a large Unicode document, an orphan source (a run with no D1 row), a manifest with malformed JSON when asked.
const bucketObjects=({extra={}}={})=>({
 'watchlist.json':json({films:[{id:'heat-1995'}]}),'programme.json':json({runId:'run-1',films:[]}),'sync.json':json({updatedAt:'2026-10-26T10:00:00.000Z',failures:[]}),
 'epg/published-generation.json':json({programmeRunId:'run-1',phase:'published'}),'epg/resolver-lease.json':json({id:'lease-1'}),'epg/resolver-continuation.json':json({at:'2026-10-26T10:05:00.000Z',hopId:'hop-7'}),
 'enrichment/writer-lease.json':json({id:'writer-1'}),'enrichment/runner-lease.json':json({id:'runner-1'}),'enrichment/profile/current.json':json({version:3,profileHash:'profile-3'}),
 'enrichment/latest-run.json':json({runId:'enrichment-run-9'}),'enrichment/films/tmdb_7/fingerprint.json':json({fingerprintHash:'print-7'}),
 'events/items/9999999999999-keep-out.json':json({note:'the Events journal stays R2 and is not converted'}),
 ...Object.fromEntries(Object.entries(legacy).map(([key,value])=>[key,json(value)])),
 'enrichment/sources/orphan-run.json':json({'tmdb_999':{title:'Фильм «🎬» — 漢字','modelMetadata':{note:'x'.repeat(5000)}}}),
 ...extra
});
async function snapshotOf(objects,{pageSize=4}={}){
 const bucket=fakeBucket(objects,{pageSize});const endpoint=await bucket.start();
 const directory=tmp();
 try{await exportProductionSnapshot({directory,credentials:readCredentials(envFor(endpoint)),sleep:noSleep});}finally{await bucket.stop();}
 return {directory,bucket};
}
const manifestOf=directory=>JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
const writeManifest=(directory,manifest)=>fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
const cloneSnapshot=(directory)=>{const copy=tmp();fs.cpSync(directory,copy,{recursive:true});return copy;};
const absent=output=>assert.equal(fs.existsSync(output),false,'a refused run leaves no output behind');

// The one snapshot every case starts from.
const objects=bucketObjects();
const {directory:snapshot,bucket}=await snapshotOf(objects);
const rawBytes=key=>Buffer.from(bucket.items.get(key).bytes);

// ---- 1. Happy path: a consistent fenced snapshot converts exactly the four families, byte for byte, and the importer reads the tree ----
{
 const output=path.join(tmp(),'out');
 const report=await convertSnapshot({snapshot,output});
 const families=[...new Set(Object.keys(objects).map(auxExportFamily).filter(Boolean))].sort();
 assert.deepEqual(Object.keys(report.converted.families).sort(),families,'exactly the four families (stage, outbox, sources, manifests, events)');
 assert.equal(report.converted.objects,Object.keys(objects).filter(auxExportFamily).length);
 assert.equal(report.snapshot.status,'consistent_fenced');assert.ok(report.converted.skippedObjects>=Object.keys(objects).length-report.converted.objects,'every other object was left out');
 const tree=path.join(output,'tree');
 const copied=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else copied.push(path.relative(tree,full).split(path.sep).join('/'));}};walk(tree);
 assert.deepEqual(copied.sort(),Object.keys(objects).filter(auxExportFamily).sort(),'no noise, no fence key, no journal item was copied');
 for(const key of copied)assert.ok(fs.readFileSync(path.join(tree,key)).equals(rawBytes(key)),key+': the exact stored bytes (incl. large Unicode)');
 // the identity the cutover compares: key, ETag, size, SHA-256 of what was read
 const identity=JSON.parse(fs.readFileSync(path.join(output,'identity.json'),'utf8'));
 assert.deepEqual(identity.map(item=>item.key),[...copied].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),'sorted by key');
 for(const item of identity){const stored=bucket.items.get(item.key);assert.equal(item.etag,stored.etag);assert.equal(item.size,stored.bytes.length);assert.equal(item.sha256,sha256(stored.bytes));}
 assert.equal(Aux.auxFlipRefusal(identity.map(({key,etag,size})=>({key,etag,size})),identity.map(({key,etag,size})=>({key,etag,size}))),null,'the identity feeds auxFlipRefusal');
 assert.ok(fs.existsSync(path.join(output,'converter-report.json')),'the report is written last');
 for(const mode of [fs.statSync(output).mode,fs.statSync(tree).mode])assert.equal(mode&0o077,0,'private directories');
 assert.equal(fs.statSync(path.join(tree,'enrichment/batch-stage.json')).mode&0o077,0,'private files');
 // the importer reads the converted tree and produces the SAME plan as the export it came from (counts and digests)
 const fromTree=await buildPlan(readExport(tree));assert.deepEqual(fromTree.blockers,[]);
 const direct=await buildPlan(Object.fromEntries(Object.entries(objects).filter(([key])=>auxExportFamily(key)).map(([key,text])=>[key,JSON.parse(text)])));
 assert.deepEqual(await planReport(fromTree),await planReport(direct),'the bridge changes no count and no digest');
 const planned=await planReport(fromTree);assert.equal(planned.stage.items,2);assert.equal(planned.sources.runs,2,'the run and the orphan source');assert.equal(planned.manifests.count,1);assert.ok(planned.outbox.total>=2);
 // report, digest, preflight, sql and verify through the CLI on the converted tree
 for(const command of ['report','digest','preflight'])assert.equal(runImporter(command,tree).status,0,command);
 const generation=Number(5);
 assert.equal(runImporter('sql',tree).status,2,'sql still needs the closure generation');
 const printed=runImporter('sql',tree,'--generation',String(generation));assert.equal(printed.status,0);
 const verify=runImporter('verify',tree);assert.equal(verify.status,0);
 // the SQL imports into an empty database under the closure it names, and its verification passes on the rows
 const file=migrated();sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=1");sql(file,"UPDATE prediction_aux_authority SET mode='r2', generation=2");sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=3");
 assert.throws(()=>applySql(file,planSql(fromTree,1)),/CHECK constraint failed: ok/,'the plan of another closure refuses');
 sql(file,"UPDATE prediction_aux_authority SET mode='r2', generation=4");sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=5");
 applySql(file,printed.stdout);applySql(file,verify.stdout);
 assert.equal(Number(sql(file,'SELECT count(*) AS n FROM prediction_batch_stage')[0].n),2,'the held stage');
 assert.equal(Number(sql(file,'SELECT count(*) AS n FROM prediction_run_manifest')[0].n),1);
 // the orphan source: its run id is NOT in prediction_run, so the read-only preflight answers without it (a true orphan to classify)
 const preflight=planRunPreflightSql(fromTree);assert.ok(preflight.ids.includes('orphan-run')&&preflight.ids.includes(runId));
 const answered=new Set(sql(file,preflight.sql.replace(/;\n?$/,'')).map(row=>row.run_id));
 assert.equal(answered.has('orphan-run'),false,'the orphan source has no run row');
 // the public output carries counts and digests, never a document body
 const cli=spawnSync(process.execPath,['scripts/prediction-aux-export-convert.mjs',snapshot,path.join(tmp(),'cli-out')],{encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);assert.doesNotMatch(cli.stdout,/漢字|modelMetadata|tmdb_999|heat-1995/);assert.equal(JSON.parse(cli.stdout).converted.objects,report.converted.objects);
}

// ---- 2. Refusals: a snapshot that is not a verified consistent fenced cut never converts, and a refused run leaves nothing behind ----
{
 const refuseCase=async(name,prepare,code)=>{
  const copy=cloneSnapshot(snapshot);prepare(copy);
  const output=path.join(tmp(),'out');
  await refusal(convertSnapshot({snapshot:copy,output}),code);absent(output);
  const cli=spawnSync(process.execPath,['scripts/prediction-aux-export-convert.mjs',copy,path.join(tmp(),'cli')],{encoding:'utf8'});
  assert.equal(cli.status,2,name+': exit 2');assert.equal(cli.stdout,'',name+': nothing on stdout');assert.match(cli.stderr,/^REFUSED: /);
 };
 const fileOf=(copy,key)=>path.join(copy,manifestOf(copy).objects.find(entry=>entry.key===key).file);
 const sourceKey='enrichment/sources/'+runId+'.json';
 await refuseCase('no manifest (an incomplete export)',copy=>fs.rmSync(path.join(copy,'manifest.json')),'snapshot_not_verified');
 await refuseCase('no-go status',copy=>{const m=manifestOf(copy);m.status='no_go';m.noGoReasons=['source_changed'];writeManifest(copy,m);},'snapshot_not_consistent');
 await refuseCase('a change between the listings',copy=>{const m=manifestOf(copy);m.changes=[{key:'sync.json',reason:'metadata_changed'}];writeManifest(copy,m);},'snapshot_not_consistent');
 await refuseCase('a fence that did not hold',copy=>{const m=manifestOf(copy);m.fence.ok=false;writeManifest(copy,m);},'snapshot_not_consistent');
 await refuseCase('a missing object file',copy=>fs.rmSync(fileOf(copy,sourceKey)),'snapshot_not_verified');
 await refuseCase('a changed object (same length, other bytes)',copy=>{const file=fileOf(copy,sourceKey),bytes=fs.readFileSync(file);bytes[bytes.length-3]=bytes[bytes.length-3]^1;fs.writeFileSync(file,bytes);},'snapshot_not_verified');
 await refuseCase('a truncated object',copy=>{const file=fileOf(copy,sourceKey);fs.writeFileSync(file,fs.readFileSync(file).subarray(0,10));},'snapshot_not_verified');
 await refuseCase('a duplicated manifest entry',copy=>{const m=manifestOf(copy);m.objects.push(m.objects.find(entry=>entry.key===sourceKey));writeManifest(copy,m);},'snapshot_not_verified');
 await refuseCase('a weak ETag',copy=>{const m=manifestOf(copy);m.objects.find(entry=>entry.key===sourceKey).metadata.etag='W/"abc"';writeManifest(copy,m);},'etag_missing_or_weak');
 await refuseCase('a missing ETag',copy=>{const m=manifestOf(copy);delete m.objects.find(entry=>entry.key===sourceKey).metadata.etag;writeManifest(copy,m);},'etag_missing_or_weak');
 await refuseCase('metadata that names another key',copy=>{const m=manifestOf(copy);m.objects.find(entry=>entry.key===sourceKey).metadata.key='enrichment/sources/other.json';writeManifest(copy,m);},'metadata_mismatch');
 await refuseCase('metadata with another size',copy=>{const m=manifestOf(copy);m.objects.find(entry=>entry.key===sourceKey).metadata.size+=1;writeManifest(copy,m);},'snapshot_not_verified');
 // the segments of a key become a path inside the tree: nothing that could leave it is accepted
 for(const key of ['enrichment/sources/../escape.json','enrichment/sources/./x.json','enrichment/sources//x.json','enrichment/sources/a\\b.json','enrichment/sources/a\u0000b.json'])assert.throws(()=>safeSegments(key),error=>error instanceof Refusal&&error.code==='unsafe_key',JSON.stringify(key));
 assert.deepEqual(safeSegments('enrichment/sources/run 1/ф.json'),['enrichment','sources','run 1','ф.json']);
 // paths: absolute, outside the repository, new or empty, not overlapping the snapshot
 await refusal(convertSnapshot({snapshot:'relative/dir',output:path.join(tmp(),'o')}),'path_not_absolute');
 await refusal(convertSnapshot({snapshot,output:'relative/out'}),'path_not_absolute');
 await refusal(convertSnapshot({snapshot,output:path.resolve('tests/_converted_out')}),'path_inside_repository');absent(path.resolve('tests/_converted_out'));
 await refusal(convertSnapshot({snapshot:path.resolve('tests'),output:path.join(tmp(),'o')}),'path_inside_repository');
 await refusal(convertSnapshot({snapshot,output:path.join(snapshot,'inside')}),'paths_overlap');
 const busy=tmp();fs.writeFileSync(path.join(busy,'keep.txt'),'x');
 await refusal(convertSnapshot({snapshot,output:busy}),'output_not_empty');assert.equal(fs.readFileSync(path.join(busy,'keep.txt'),'utf8'),'x','a non-empty output directory is not touched');
 const empty=tmp();const done=await convertSnapshot({snapshot,output:empty});assert.ok(done.converted.objects>0,'an existing EMPTY directory is accepted');
 // the bytes are hashed again AT the copy: a file that changes after the snapshot verified (same length, other bytes) is refused and what was written is removed
 for(const mutate of [bytes=>{bytes[bytes.length-3]=bytes[bytes.length-3]^1;return bytes;},bytes=>bytes.subarray(0,bytes.length-1)]){
  const late=cloneSnapshot(snapshot);const lateOut=path.join(tmp(),'out');
  await refusal(convertSnapshot({snapshot:late,output:lateOut,afterVerify:()=>{const file=path.join(late,manifestOf(late).objects.find(entry=>entry.key==='enrichment/batch-stage.json').file);fs.writeFileSync(file,mutate(Buffer.from(fs.readFileSync(file))));}}),'object_changed');absent(lateOut);
 }
 // a refusal after the directory was created removes what this run wrote (here: an existing empty directory, refused by an object that changed after the check is simulated through a corrupt copy)
 const corrupt=cloneSnapshot(snapshot);const m=manifestOf(corrupt);m.objects.find(entry=>entry.key===('enrichment/sources/'+runId+'.json')).metadata.etag='W/"x"';writeManifest(corrupt,m);
 const emptyOut=tmp();await refusal(convertSnapshot({snapshot:corrupt,output:emptyOut}),'etag_missing_or_weak');assert.deepEqual(fs.readdirSync(emptyOut),[],'an existing empty directory is left empty');
 // usage
 assert.equal(spawnSync(process.execPath,['scripts/prediction-aux-export-convert.mjs'],{encoding:'utf8'}).status,1);
 assert.equal(spawnSync(process.execPath,['scripts/prediction-aux-export-convert.mjs',snapshot,path.join(tmp(),'o'),'extra'],{encoding:'utf8'}).status,1);
}

// ---- 3. A malformed document is handed over unchanged and stops the importer; a key the importer would not consume is refused by the converter AND blocked by the importer (review of PR 896) ----
{
 const {directory:bad}=await snapshotOf(bucketObjects({extra:{'enrichment/batch-manifest/bad-run.json':'{not json'}}));
 const output=path.join(tmp(),'out');const report=await convertSnapshot({snapshot:bad,output});
 const tree=path.join(output,'tree');
 assert.equal(fs.readFileSync(path.join(tree,'enrichment/batch-manifest/bad-run.json'),'utf8'),'{not json','the malformed bytes are not rewritten or dropped');
 assert.equal(report.converted.objects,Object.keys(objects).filter(auxExportFamily).length+1);
 const blocked=runImporter('report',tree);assert.equal(blocked.status,2,'the importer blocks');assert.match(blocked.stderr,/BLOCKER/);
 assert.equal(runImporter('sql',tree,'--generation','1').stdout,'','and prints no SQL');
}
// Every selected key must have a shape the importer consumes. Forms the review named, and the other prefixes: none is copied, counted or left to be ignored.
const UNCONSUMED=['enrichment/sources/run.backup.json','enrichment/sources/run.bin','enrichment/sources/sub/run.json','enrichment/batch-manifest/run.v2.json','enrichment/batch-manifest/run.bin','enrichment/stop-events/x.bin','enrichment/stop-events/unexpected name.json','enrichment/start-events/y.json.bak','enrichment/batch-stage.json.bak'];
for(const key of UNCONSUMED){
 if(auxExportFamily(key)===null){assert.equal(key,'enrichment/batch-stage.json.bak','only the stage backup is outside every family prefix');continue;}
 const {directory:odd}=await snapshotOf(bucketObjects({extra:{[key]:json({unexpected:true})}}));
 const output=path.join(tmp(),'out');
 await refusal(convertSnapshot({snapshot:odd,output}),'unconsumed_key');absent(output);
 fs.rmSync(odd,{recursive:true,force:true});
}
// The importer does not depend on the converter for that: the same shapes in a plain tree are blockers (including non-JSON files), never ignored objects, and no SQL is printed.
{
 const tree=tmp();
 const put=(key,text)=>{fs.mkdirSync(path.dirname(path.join(tree,key)),{recursive:true});fs.writeFileSync(path.join(tree,key),text);};
 for(const [key,value] of Object.entries(legacy))put(key,json(value));
 assert.equal(runImporter('report',tree).status,0,'the clean tree reports');
 for(const key of UNCONSUMED.filter(auxExportFamily)){
  const copy=tmp();fs.cpSync(tree,copy,{recursive:true});
  fs.mkdirSync(path.dirname(path.join(copy,key)),{recursive:true});fs.writeFileSync(path.join(copy,key),key.endsWith('.json')?json({unexpected:true}):'raw bytes');
  const report=runImporter('report',copy);assert.equal(report.status,2,key+': the importer blocks');assert.match(report.stderr,/_key_unknown/,key);
  assert.equal(runImporter('sql',copy,'--generation','1').stdout,'',key+': no SQL is printed');
 }
 const plan=await buildPlan({...Object.fromEntries(Object.entries(legacy)),'enrichment/sources/run.backup.json':{a:1}});
 assert.ok(plan.blockers.some(item=>item.code==='source_key_unknown'),'a source name the importer does not consume is a blocker, not ignoredObjects');
 assert.equal((await planReport(plan)).ignoredObjects,0);
}

// ---- 3b. The private output boundary is the REAL location, not the spelling of the path (review of PR 896) ----
{
 const inside=fs.mkdtempSync(path.join(path.resolve('tests'),'_converter-link-'));   // an empty directory of this public repository
 try{
  const outsideDir=tmp();
  const link=path.join(outsideDir,'link');fs.symlinkSync(inside,link);
  await refusal(convertSnapshot({snapshot,output:link}),'path_symlink');
  assert.deepEqual(fs.readdirSync(inside),[],'a symlinked output wrote nothing into the repository');
  // a symlinked PARENT that leads into the repository, for a new target
  const parentLink=path.join(outsideDir,'parent');fs.symlinkSync(inside,parentLink);
  await refusal(convertSnapshot({snapshot,output:path.join(parentLink,'new')}),'path_inside_repository');
  await refusal(convertSnapshot({snapshot,output:path.join(parentLink,'deep','er','new')}),'path_inside_repository');
  assert.deepEqual(fs.readdirSync(inside),[],'a symlinked parent wrote nothing into the repository either');
  // a symlink to an empty directory OUTSIDE the repository is still refused as the target itself (no link is ever followed for the output), a link as a parent that stays outside is fine
  const away=tmp();const awayLink=path.join(outsideDir,'away');fs.symlinkSync(away,awayLink);
  await refusal(convertSnapshot({snapshot,output:awayLink}),'path_symlink');assert.deepEqual(fs.readdirSync(away),[],'and nothing was written through it');
  const ok=await convertSnapshot({snapshot,output:path.join(awayLink,'out')});assert.ok(ok.converted.objects>0);assert.ok(fs.existsSync(path.join(away,'out','tree')),'a parent link that stays outside the repository is accepted');
  // a dangling link on the way is not a location
  const dangling=path.join(outsideDir,'dangling');fs.symlinkSync(path.join(outsideDir,'nowhere'),dangling);
  await refusal(convertSnapshot({snapshot,output:dangling}),'path_symlink');
  await refusal(convertSnapshot({snapshot,output:path.join(dangling,'out')}),'path_unresolvable');
  // the snapshot may not be reached through a link into the repository either
  const snapLink=path.join(outsideDir,'snap');fs.symlinkSync(path.resolve('tests'),snapLink);
  await refusal(convertSnapshot({snapshot:snapLink,output:path.join(tmp(),'o')}),'path_inside_repository');
  // the CLI refuses the same way and creates nothing
  const cli=spawnSync(process.execPath,['scripts/prediction-aux-export-convert.mjs',snapshot,link],{encoding:'utf8'});assert.equal(cli.status,2);assert.match(cli.stderr,/path_symlink/);assert.deepEqual(fs.readdirSync(inside),[]);
 }finally{fs.rmSync(inside,{recursive:true,force:true});}
}

// ---- 4. The pure file of the converter names no write to a database, a bucket or the network ----
{
 const source=fs.readFileSync('scripts/prediction-aux-export-convert.mjs','utf8');
 assert.doesNotMatch(source,/\bfetch\(|XMLHttpRequest|node:http|node:https|node:net|wrangler|R2_SNAPSHOT_|BUCKET|\.prepare\(|child_process/,'offline: no network, no credential, no database, no bucket binding');
 assert.doesNotMatch(source,/execSync|spawn/);
}
for(const directory of [snapshot])fs.rmSync(directory,{recursive:true,force:true});
await bucket.stop().catch(()=>{});
console.log('prediction aux export convert: ok');
