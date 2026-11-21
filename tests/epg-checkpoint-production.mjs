// The EPG checkpoint production operator (scripts/epg-checkpoint-production.mjs): exact transition contracts, drain proof, import parity, rollback export.
// Offline only: a sqlite D1 stand-in over the real migration chain and an in-memory R2 stand-in. No production database or bucket is opened.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Op from '../scripts/epg-checkpoint-production.mjs';
import * as Checkpoint from '../src/epg-checkpoint-d1.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-ckpt-op-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name!=='0032_letterboxd_sync_control.sql').sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const sha=text=>createHash('sha256').update(text).digest('hex');
// 18:00 UTC on 20 Nov: after the natural run completed (16:12 UTC) and the same Madrid day, which is the H0 boundary of the plan.
const NOW=Date.parse('2026-11-20T18:00:00.000Z');
const EV={workflowInstanceId:'epg_20261120_1',workflowLiveness:'finished',deployedVersionId:'v-1'};
const RUN='84821d8a-0000-4000-8000-000000000001';
const SYNC=JSON.stringify({runId:RUN,startedAt:'2026-11-20T16:00:05.000Z',runKey:'2026-11-20',updatedAt:'2026-11-20T16:11:45.255Z',stage:'complete',remaining:0,failures:[],events:[],completedAt:'2026-11-20T16:11:45.255Z'});
const INGEST=JSON.stringify({schemaVersion:1,failedAt:null,lastSuccessAt:'2026-11-20T16:11:45.255Z'});
let copies=0;
function seed(file,{lease='released',phase='done',nextWake='2026-11-21T16:00:00.000Z',pause='clear',finalized=RUN,control={}}={}){
 const leaseBody=lease==='released'?{schemaVersion:1,holder:'h',modeRevision:2,expiresAt:'2026-11-20T16:16:29.753Z',released:true}:{schemaVersion:1,holder:'h',modeRevision:2,expiresAt:'2026-11-21T09:00:00.000Z',released:false};
 sqlite(file,"DELETE FROM epg_orchestration_document;INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"cloudflare\",\"epoch\":1,\"drain\":\"verified\"}',2,'2026-11-08T00:00:00.000Z'),('control','"+JSON.stringify({schemaVersion:1,phase,nextWakeAt:nextWake,runId:RUN,runKey:'2026-11-20',instanceId:'epg_20261120_1',versionId:'v-1',...control}).replace(/'/g,"''")+"',5,'2026-11-20T16:11:56.000Z'),('lease','"+JSON.stringify(leaseBody)+"',9,'2026-11-20T16:11:56.000Z');UPDATE discovery_epg_priority SET state='"+pause+"', owed_day_key="+(pause==='clear'?'NULL':"'2026-11-20'")+";UPDATE published_epg_authority SET programme_run_id='"+RUN+"', finalized_run_id="+(finalized?"'"+finalized+"'":'NULL')+";");
}
function open(upTo='0030_epg_checkpoint_authority.sql',options={}){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');
 sqlite(file,chain(upTo));
 seed(file,options);
 return {file,db:d1Standin(file)};
}
// An in-memory bucket with strong ETags and conditional writes.
function bucket(initial){
 const objects=new Map(Object.entries(initial).map(([key,text],index)=>[key,{text,etag:'e'+index+'-0'}]));
 let n=0;const puts=[];
 const view=key=>{const o=objects.get(key);return o?{etag:o.etag,size:Buffer.byteLength(o.text,'utf8')}:null;};
 const store=allowed=>({
  async head(key){return view(key);},
  async get(key){const o=objects.get(key);return o?{...view(key),text:async()=>o.text}:null;},
  async put(key,text,{onlyIf}={}){
   if(allowed&&!allowed.has(key))throw new Error('refused');
   const o=objects.get(key);
   if(!o||o.etag!==onlyIf?.etagMatches)return null;
   if(store.failAfter!==undefined&&puts.length>=store.failAfter)throw new Error('lost reply');
   n++;o.text=text;o.etag='w'+n;puts.push(key);return {etag:o.etag};
  },
 });
 const read=store(null);
 return {read,write:allowed=>store(allowed),objects,puts,fail:count=>{store.failAfter=count;}};
}
// The frozen R2 text is pretty-printed, so the compact text exported from D1 differs byte for byte and the export really writes.
const SYNC_RAW=JSON.stringify(JSON.parse(SYNC),null,1);
const frozen={'sync.json':SYNC_RAW,'watchlist-ingest.json':INGEST};
const call=(command,args,env,options={})=>Op.execute(command,args,{binding:env.db,readStore:env.r2.read,writeStoreFactory:env.r2.write,now:options.now??NOW,ctx:options.ctx??{}});
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,'expected '+reason+' got '+error.reason);return error;}assert.fail('must stop with '+reason);};
const marker=file=>rows(file,'SELECT mode,writes,generation FROM epg_checkpoint_authority')[0];
const counts=file=>rows(file,'SELECT (SELECT COUNT(*) FROM epg_checkpoint_run) AS run,(SELECT COUNT(*) FROM epg_checkpoint_body) AS body,(SELECT COUNT(*) FROM epg_checkpoint_film) AS film,(SELECT COUNT(*) FROM epg_ingest_status) AS ingest')[0];
const identity=env=>({syncEtag:env.r2.objects.get('sync.json').etag,syncSha256:sha(env.r2.objects.get('sync.json').text),ingestEtag:env.r2.objects.get('watchlist-ingest.json').etag,ingestSha256:sha(env.r2.objects.get('watchlist-ingest.json').text)});

// ===== 1. arguments: read-only by default, one command, confirm token, no target no write =====
{
 const A=(...a)=>['node','x',...a];
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 for(const command of Op.COMMANDS.filter(c=>c!=='status'))assert.throws(()=>Op.parseArgs(A('--'+command)),e=>e.reason==='target_required',command);
 assert.throws(()=>Op.parseArgs(A('--hold','--target','other','--confirm','hold','--expect-generation','0')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A('--hold','--target','iptv','--expect-generation','0')),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--hold','--target','iptv','--confirm','import','--expect-generation','0')),e=>e.reason==='confirm','the token is the command name');
 assert.throws(()=>Op.parseArgs(A('--hold','--target','iptv','--confirm','hold')),e=>e.reason==='usage','the expected generation is required');
 assert.throws(()=>Op.parseArgs(A('--hold','--import','--target','iptv','--confirm','hold','--expect-generation','0')),e=>e.reason==='usage','one command only');
 assert.throws(()=>Op.parseArgs(A('--import','--target','iptv','--confirm','import','--expect-generation','0')),e=>e.reason==='usage','identity is required');
 assert.throws(()=>Op.parseArgs(A('--status','--target','iptv','--confirm','status')),e=>e.reason==='usage');
 assert.equal(Op.parseArgs(A('--target','iptv')).command,'status');
 const r=spawnSync(process.execPath,['scripts/epg-checkpoint-production.mjs'],{encoding:'utf8'});assert.equal(r.status,0);
 assert.deepEqual(JSON.parse(r.stdout),{configured:false,writes:false,writeState:'none'});
}

// ===== 2. apply: schema 29 only, drain proof first, marker r2/open/0 readback =====
{
 const env={...open('0029_started_authority.sql'),r2:bucket(frozen)};
 await stop(call('hold',{generation:0,...EV},env),'schema_unexpected');
 for(const [options,failure] of [[{lease:'live'},'step_lease_live'],[{phase:'running'},'orchestration_not_done'],[{nextWake:'2026-11-20T18:10:00.000Z'},'next_start_too_close'],[{nextWake:'2026-11-20T17:00:00.000Z'},'next_start_too_close'],[{control:{runKey:'2026-11-19'}},'control_not_current_day'],[{control:{runId:'another-run'}},'run_identity_mismatch'],[{pause:'paused'},'discovery_pause_not_clear'],[{finalized:null},'run_identity_mismatch']]){
  const bad={...open('0029_started_authority.sql',options),r2:bucket(frozen)};
  const error=await stop(call('apply',{...EV},bad),'drain_refused');
  assert.ok(error.details.failures.includes(failure),failure);
  assert.equal(rows(bad.file,'SELECT version FROM schema_contract')[0].version,29,'a refused apply changes nothing');
 }
 const seal=bucket({...frozen,'sync.json':JSON.stringify({...JSON.parse(SYNC),stage:'seal',seal:{phase:'ledger'},completedAt:undefined})});
 await stop(call('apply',{...EV},{...open('0029_started_authority.sql'),r2:seal}),'drain_refused');
 const result=await call('apply',{...EV},env);
 assert.equal(result.writeState,'committed');assert.deepEqual(result.marker,{mode:'r2',writes:'open',generation:0,cas:1});
 assert.equal(rows(env.file,'SELECT version FROM schema_contract')[0].version,30);
 await stop(call('apply',{...EV},env),'already_applied');
 const v28={...open('0028_filter_preset_authority.sql'),r2:bucket(frozen)};
 await stop(call('apply',{...EV},v28),'schema_unexpected');
}

// ===== 3. status measures, writes nothing, prints no payload =====
{
 const env={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};
 const status=await call('status',{...EV},env);
 assert.equal(status.writes,false);assert.deepEqual(status.marker,{mode:'r2',writes:'open',generation:0,cas:1});
 assert.equal(status.drain.ok,true);assert.equal(status.r2.measure.stage,'complete');assert.equal(status.r2.measure.watchlist,null,'a complete run has no film figure');
 assert.equal(JSON.stringify(status).includes(RUN+'","startedAt'),false);assert.equal(JSON.stringify(status).includes('updatedAt":"2026'),false,'no raw payload');
 assert.equal(status.r2.sync.sha256,sha(SYNC_RAW));
 const mid=bucket({...frozen,'sync.json':JSON.stringify({runId:'r',startedAt:'2026-11-21T16:00:00.000Z',stage:'metadata',watchlist:[{id:'a',t:'xx'},{id:'b',t:'xxxxxxxx'}],pending:[]})});
 const measured=await call('status',{...EV},{...open('0030_epg_checkpoint_authority.sql'),r2:mid});
 assert.equal(measured.r2.measure.watchlist.films,2);assert.ok(measured.r2.measure.watchlist.maxFilmChars>=16);assert.ok(measured.drain.failures.includes('run_not_complete'));
}

// ===== 4. the full forward sequence: hold, import, activate, release; every contract is exact =====
{
 const env={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};
 await stop(call('hold',{generation:1,...EV},env),'state_mismatch');
 await stop(call('import',{generation:0,...identity(env)},env),'state_mismatch');
 await stop(call('activate',{generation:0,...identity(env)},env),'state_mismatch');
 await stop(call('release',{generation:0},env),'state_mismatch');
 await stop(call('hold',{generation:0,...EV},env,{now:Date.parse('2026-11-20T23:40:00.000Z')}),'drain_refused');
 await stop(call('hold',{generation:0,...EV},env,{now:Date.parse('2026-11-21T08:00:00.000Z')}),'drain_refused');
 assert.deepEqual(marker(env.file),{mode:'r2',writes:'open',generation:0});
 const held=await call('hold',{generation:0,...EV},env);
 assert.deepEqual(held.marker,{mode:'r2',writes:'held',generation:1});
 await stop(call('hold',{generation:0,...EV},env),'state_mismatch');
 // identity: another object, a changed ETag or a changed digest refuses; tables stay empty
 const id=identity(env);
 await stop(call('import',{generation:1,...id,syncEtag:'other'},env),'identity_mismatch');
 await stop(call('import',{generation:1,...id,syncSha256:'0'.repeat(64)},env),'identity_mismatch');
 assert.deepEqual(counts(env.file),{run:0,body:0,film:0,ingest:0});
 await stop(call('activate',{generation:1,...id},env),'import_missing');
 const imported=await call('import',{generation:1,...id},env);
 assert.equal(imported.parity,'verified');assert.deepEqual(counts(env.file),{run:1,body:1,film:0,ingest:1});
 assert.equal(JSON.stringify(imported).includes('startedAt'),false);
 await stop(call('import',{generation:1,...id},env),'predicate_refused');
 assert.deepEqual(counts(env.file),{run:1,body:1,film:0,ingest:1},'a second import writes nothing');
 // release-abort needs empty tables; the imported rows block it
 await stop(call('release-abort',{generation:1},env),'predicate_refused');
 assert.deepEqual(marker(env.file),{mode:'r2',writes:'held',generation:1});
 // a changed R2 object after import refuses the activation
 const moved=bucket({...frozen,'sync.json':SYNC.replace('"remaining":0','"remaining":0,"x":1')});
 await stop(Op.execute('activate',{generation:1,...id},{binding:env.db,readStore:moved.read,now:NOW}),'identity_mismatch');
 // tampered import: a changed body chunk refuses with the parity list
 sqlite(env.file,"UPDATE epg_checkpoint_body SET text=replace(text,'complete','complete ') WHERE seq=0");
 const tampered=await stop(call('activate',{generation:1,...id},env),'parity_mismatch');assert.ok(tampered.details.mismatches.includes('body'));
 sqlite(env.file,"UPDATE epg_checkpoint_body SET text=replace(text,'complete ','complete') WHERE seq=0");
 const active=await call('activate',{generation:1,...id},env);
 assert.deepEqual(active.marker,{mode:'d1',writes:'held',generation:2});
 const loaded=await Checkpoint.loadRun(env.db);assert.equal(loaded.ok,true);assert.equal(loaded.run.runId,RUN);assert.equal(loaded.run.stage,'complete');
 assert.deepEqual((await Checkpoint.readIngest(env.db)).status,{schemaVersion:1,failedAt:null,lastSuccessAt:'2026-11-20T16:11:45.255Z',consecutiveFailures:0});
 await stop(call('activate',{generation:1,...id},env),'state_mismatch');
 assert.throws(()=>Op.parseArgs(['node','x','--release','--target','iptv','--confirm','release','--expect-generation','2']),e=>e.reason==='usage','release needs both frozen identities');
 await stop(call('release',{generation:2},env),'identity_mismatch');
 await stop(call('release',{generation:2,...id,syncSha256:'0'.repeat(64)},env),'identity_mismatch');
 const released=await call('release',{generation:2,...id},env);
 assert.deepEqual(released.marker,{mode:'d1',writes:'open',generation:2});
 assert.equal(env.r2.puts.length,0,'the forward sequence never writes R2');
 // a later D1 write (the next natural run would do this): the ingest status moves on, so the D1 state no longer equals the frozen image
 sqlite(env.file,"UPDATE epg_ingest_status SET last_success_at='2026-11-21T16:12:00.000Z', revision=revision+1");
 env.cutover={id};
 // ===== 5. rollback: hold, export (conditional), revert, release; D1 rows are kept =====
 await stop(call('hold-rollback',{generation:1,...EV},env),'state_mismatch');
 await stop(call('hold-rollback',{generation:2,...EV},{...env,db:d1Standin(env.file)},{now:Date.parse('2026-11-21T08:00:00.000Z')}),'drain_refused');
 const rolled=await call('hold-rollback',{generation:2,...EV},env);
 assert.deepEqual(rolled.marker,{mode:'d1',writes:'held',generation:3});
 await stop(call('revert-authority',{generation:3},env),'export_not_verified');
 assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:3},'the marker does not move before the export is read back');
 await stop(call('export-rollback',{generation:3},env),'usage');
 await stop(call('export-rollback',{generation:3,frozenSyncEtag:'stale',frozenIngestEtag:id.ingestEtag},env),'foreign_writer');
 assert.equal(env.r2.puts.length,0);
 // partial export: the first PUT lands, the second loses its reply -> reported, never replayed blind
 env.r2.fail(1);
 const uncertain=await stop(call('export-rollback',{generation:3,frozenSyncEtag:id.syncEtag,frozenIngestEtag:id.ingestEtag},env),'write_uncertain');
 assert.equal(uncertain.details.classification,'observed','the first uncertain outcome comes with an immediate read of both objects and the marker');
 assert.equal(uncertain.details.observed.syncEqualsExport,true);assert.equal(uncertain.details.observed.ingestEqualsExport,false);
 assert.deepEqual(uncertain.details.marker,{mode:'d1',writes:'held',generation:3});
 assert.deepEqual(env.r2.puts,['sync.json']);
 await stop(call('revert-authority',{generation:3},env),'export_not_verified');
 env.r2.fail(99);
 const exported=await call('export-rollback',{generation:3,frozenSyncEtag:id.syncEtag,frozenIngestEtag:id.ingestEtag},env);
 assert.deepEqual(exported.results,{sync:'already_equal',ingest:'written'},'only the missing object is written, with its own conditional PUT');
 assert.deepEqual(env.r2.puts,['sync.json','watchlist-ingest.json']);
 assert.equal(JSON.parse(env.r2.objects.get('sync.json').text).runId,RUN);
 assert.deepEqual(JSON.parse(env.r2.objects.get('watchlist-ingest.json').text),{schemaVersion:1,failedAt:null,lastSuccessAt:'2026-11-21T16:12:00.000Z'},'the ingest document keeps the shape the R2 object had, without the counter');
 const again=await call('export-rollback',{generation:3,frozenSyncEtag:id.syncEtag,frozenIngestEtag:id.ingestEtag},env);
 assert.equal(again.writes,false);assert.deepEqual(env.r2.puts,['sync.json','watchlist-ingest.json'],'a repeat writes nothing');
 const reverted=await call('revert-authority',{generation:3},env);
 assert.deepEqual(reverted.marker,{mode:'r2',writes:'held',generation:4});
 assert.deepEqual(counts(env.file),{run:1,body:1,film:0,ingest:1},'no rollback step deletes a D1 row');
 await stop(call('release-abort',{generation:4},env),'predicate_refused');
 // (e) reopens writes only on the exported image, read fresh: a changed or an incomplete image is refused before the CAS.
 const image=identity(env);
 assert.throws(()=>Op.parseArgs(['node','x','--release-rolled-back','--target','iptv','--confirm','release-rolled-back','--expect-generation','4']),e=>e.reason==='usage');
 await stop(call('release-rolled-back',{generation:4},env),'identity_mismatch');
 await stop(call('release-rolled-back',{generation:4,...image,ingestSha256:'0'.repeat(64)},env),'identity_mismatch');
 env.r2.objects.get('watchlist-ingest.json').etag='moved';
 await stop(call('release-rolled-back',{generation:4,...image},env),'identity_mismatch');
 assert.deepEqual(marker(env.file),{mode:'r2',writes:'held',generation:4});
 env.r2.objects.get('watchlist-ingest.json').etag=image.ingestEtag;
 // the dangerous case: a foreign writer changes an object after the revert and the caller presents the NEW fingerprints; the retained D1 rows are the proof
 const foreign=env.r2.objects.get('sync.json'),goodText=foreign.text,goodEtag=foreign.etag;
 foreign.text=goodText.replace('"remaining":0','"remaining":0,"x":1');foreign.etag='foreign-1';
 const fresh=identity(env);
 assert.notEqual(fresh.syncSha256,image.syncSha256);
 await stop(call('release-rolled-back',{generation:4,...fresh},env),'export_mismatch');
 assert.deepEqual(marker(env.file),{mode:'r2',writes:'held',generation:4},'the marker stays held');
 foreign.text=goodText;foreign.etag=goodEtag;
 const retained=await Op.retainedDocuments(env.db);
 assert.equal(sha(retained.syncText),image.syncSha256);assert.equal(sha(retained.ingestText),image.ingestSha256,'the retained rows reproduce the exported image');
 const reopened=await call('release-rolled-back',{generation:4,...image},env);
 assert.deepEqual(reopened.marker,{mode:'r2',writes:'open',generation:4});
 assert.deepEqual(await Checkpoint.readAuthority(env.db),{state:'r2',writes:'open',generation:4});
}

// ===== 6. abort before activation: release-abort only with empty tables =====
{
 const env={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};
 await call('hold',{generation:0,...EV},env);
 const back=await call('release-abort',{generation:1},env);
 assert.deepEqual(back.marker,{mode:'r2',writes:'open',generation:1});
}

// ===== 7. the source is validated before a statement exists =====
{
 const plan=(sync,ingest=INGEST)=>Op.importPlan({syncText:sync,ingestText:ingest,generation:1,now:NOW});
 assert.throws(()=>plan('not json'),e=>e.reason==='source_invalid');
 assert.throws(()=>plan(JSON.stringify({...JSON.parse(SYNC),stage:'seal'})),e=>e.reason==='run_not_complete');
 assert.throws(()=>plan(JSON.stringify({...JSON.parse(SYNC),watchlist:[]})),e=>e.reason==='complete_run_has_watchlist');
 assert.throws(()=>plan(JSON.stringify({...JSON.parse(SYNC),runKey:'tomorrow'})),e=>e.reason==='source_invalid');
 assert.throws(()=>plan(JSON.stringify({...JSON.parse(SYNC),runId:''})),e=>e.reason==='source_invalid');
 assert.throws(()=>plan(SYNC,JSON.stringify({schemaVersion:2})),e=>e.reason==='source_invalid');
 assert.throws(()=>plan(JSON.stringify({...JSON.parse(SYNC),pad:'x'.repeat(Op.LIMITS.bodyChars)})),e=>e.reason==='budget');
 const legacy=JSON.parse(SYNC);delete legacy.completedAt;
 assert.equal(plan(JSON.stringify(legacy)).expected.completedAt,legacy.updatedAt,'a missing completion time takes updatedAt, as completeRun does');
 assert.equal(plan(SYNC,null).expected.ingest,null);
 // A missing ingest object is never imported as 'no status': the standard cutover needs both identities, and a key that vanished after H0 refuses.
 const none={...open('0030_epg_checkpoint_authority.sql'),r2:bucket({'sync.json':SYNC_RAW})};
 await call('hold',{generation:0,...EV},none);
 const idNone={syncEtag:none.r2.objects.get('sync.json').etag,syncSha256:sha(SYNC_RAW)};
 await stop(call('import',{generation:1,...idNone,ingestEtag:'x',ingestSha256:'y'},none),'source_missing');
 assert.deepEqual(counts(none.file),{run:0,body:0,film:0,ingest:0});
 assert.throws(()=>Op.parseArgs(['node','x','--import','--target','iptv','--confirm','import','--expect-generation','1','--sync-etag','a','--sync-sha256','b']),e=>e.reason==='usage');
 // presence at H0, absence at activation and at release
 const lost={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};
 await call('hold',{generation:0,...EV},lost);
 const idLost=identity(lost);
 await call('import',{generation:1,...idLost},lost);
 lost.r2.objects.delete('watchlist-ingest.json');
 await stop(call('activate',{generation:1,...idLost},lost),'source_missing');
 assert.deepEqual(marker(lost.file),{mode:'r2',writes:'held',generation:1});
}

// ===== 7b. H0 evidence and the mutation boundary =====
{
 const base=()=>({...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)});
 const refused=async(args,failure,options={})=>{const env=options.env??base();const error=await stop(call('hold',{generation:0,...args},env),'drain_refused');assert.ok(error.details.failures.includes(failure),failure+' in '+error.details.failures);assert.deepEqual(marker(env.file),{mode:'r2',writes:'open',generation:0});};
 await refused({},'workflow_evidence_missing');
 await refused({...EV,workflowLiveness:undefined},'workflow_evidence_missing');
 await refused({...EV,workflowLiveness:'running'},'workflow_not_terminal');
 await refused({...EV,workflowLiveness:'unknown'},'workflow_not_terminal');
 await refused({...EV,workflowInstanceId:'epg_20261119_1'},'workflow_instance_mismatch');
 await refused({...EV,deployedVersionId:'v-2'},'workflow_version_mismatch','an instance on an older version than the deployed one');
 const noVersion=base();sqlite(noVersion.file,"UPDATE epg_orchestration_document SET body=json_remove(body,'$.versionId') WHERE key='control'");
 await refused(EV,'workflow_version_mismatch',{env:noVersion});
 const prevDay=base();
 // yesterday's run at today's Madrid time
 const yesterday=await stop(call('hold',{generation:0,...EV},prevDay,{now:Date.parse('2026-11-21T08:00:00.000Z')}),'drain_refused');
 assert.ok(yesterday.details.failures.includes('run_not_current_day')&&yesterday.details.failures.includes('control_not_current_day'));
 // the run is certified under another programme run
 const other=base();sqlite(other.file,"UPDATE published_epg_authority SET programme_run_id='other', finalized_run_id='other'");
 const differently=await stop(call('hold',{generation:0,...EV},other),'drain_refused');assert.ok(differently.details.failures.includes('run_identity_mismatch'));
 // event debt: the bounded semantics of the orchestrator, never the mere presence of a retained `events` array
 const WL={id:'w1',type:'watchlist',at:'2026-11-20T16:11:45.255Z'};
 const WL_KEY=Op.journalKey(WL);
 assert.match(WL_KEY,/^events\/items\/\d{13}-w1\.json$/);
 const withRun=(extra,objects={})=>({...base(),r2:bucket({...frozen,'sync.json':JSON.stringify({...JSON.parse(SYNC),...extra}),...objects})});
 // positive: a normal completed natural run keeps events:[watchlist, epg] after the successful flush, and its journal object exists
 const normal=withRun({watchlistEventFixed:true,events:[WL,{id:'e1',type:'epg',at:'2026-11-20T16:11:45.255Z'}]},{[WL_KEY]:'{}'});
 assert.equal((await call('status',{...EV},normal)).drain.ok,true,'a retained events array with its journal object is not debt');
 const accepted=await call('hold',{generation:0,...EV},normal);assert.deepEqual(accepted.marker,{mode:'r2',writes:'held',generation:1});
 // a retained error with a valid completion receipt is history, not debt
 assert.equal((await call('status',{...EV},withRun({error:'earlier attempt',completedAt:'2026-11-20T16:11:45.255Z'}))).drain.ok,true);
 // negative: real debt
 await refused(EV,'event_debt',{env:withRun({epgEventPending:{type:'epg'}})});
 await refused(EV,'event_debt',{env:withRun({watchlistEventPending:true})});
 await refused(EV,'event_debt',{env:withRun({watchlistRemovalFilms:['f1']})});
 await refused(EV,'event_debt',{env:withRun({removalRefs:[{ref:'r',films:['f1']}]})});
 await refused(EV,'event_debt',{env:withRun({removalLookups:['f1']})});
 await refused(EV,'event_debt',{env:withRun({ratingPending:['f1']})});
 await refused(EV,'event_debt',{env:withRun({watchlistEventFixed:true,events:[WL]})},'the fixed event whose journal object is missing');
 await refused(EV,'completion_receipt_unproven',{env:withRun({error:'x',completedAt:'not a date'})});
 const unreadable=withRun({watchlistEventFixed:true,events:[WL]},{[WL_KEY]:'{}'});
 const head=unreadable.r2.read.head;
 const brokenRead={...unreadable.r2.read,async head(key){if(key===WL_KEY)throw new Error('down');return head(key);}};
 const failed=await stop(Op.execute('hold',{generation:0,...EV},{binding:unreadable.db,readStore:brokenRead,now:NOW}),'drain_refused');assert.ok(failed.details.failures.includes('event_debt_unreadable'),'an unreadable journal check is fail-closed');
 // drift between the status read and the hold: each record the proof was read from is re-asserted inside the marker batch
 const drift=async mutate=>{
  const env=base();
  const state=await Op.readState(env.db);
  const proof=Op.proofFacts(state,EV);
  mutate(env.file);
  const error=await stop(Op.transition(env.db,'hold',{generation:0,now:NOW,proof}),'predicate_refused');
  assert.deepEqual(marker(env.file),{mode:'r2',writes:'open',generation:0},'the batch aborted whole');
  return error;
 };
 await drift(file=>sqlite(file,"UPDATE epg_orchestration_document SET revision=revision+1 WHERE key='control'"));
 await drift(file=>sqlite(file,"UPDATE epg_orchestration_document SET revision=revision+1 WHERE key='lease'"));
 await drift(file=>sqlite(file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.released',json('false'),'$.expiresAt','2026-11-21T09:00:00.000Z') WHERE key='lease'"));
 await drift(file=>sqlite(file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.runKey','2026-11-19') WHERE key='control'"));
 await drift(file=>sqlite(file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.versionId','v-0') WHERE key='control'"));
 await drift(file=>sqlite(file,"UPDATE discovery_epg_priority SET state='paused', owed_day_key='2026-11-20'"));
 await drift(file=>sqlite(file,"UPDATE published_epg_authority SET finalized_run_id='x'"));
 // a transition cannot be built for a hold without its proof
 assert.throws(()=>Op.transitionStatements('hold',{generation:0,now:NOW}),e=>e.reason==='drain_refused');
}

// ===== 7c. release (b): the rows still equal the frozen image, and the frozen image is unchanged =====
{
 const make=async()=>{const env={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};await call('hold',{generation:0,...EV},env);const id=identity(env);await call('import',{generation:1,...id},env);await call('activate',{generation:1,...id},env);return {env,id};};
 {
  const {env,id}=await make();
  env.r2.objects.get('sync.json').etag='moved';
  await stop(call('release',{generation:2,...id},env),'identity_mismatch');
  env.r2.objects.get('sync.json').etag=id.syncEtag;
  sqlite(env.file,"UPDATE epg_ingest_status SET last_success_at='2026-11-21T00:00:00.000Z'");
  const error=await stop(call('release',{generation:2,...id},env),'parity_mismatch');assert.ok(error.details.mismatches.includes('ingest'));
  sqlite(env.file,"UPDATE epg_ingest_status SET last_success_at='2026-11-20T16:11:45.255Z'");
  sqlite(env.file,"DELETE FROM epg_checkpoint_receipt");
  assert.ok((await stop(call('release',{generation:2,...id},env),'parity_mismatch')).details.mismatches.includes('receipt'));
  assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:2},'writes stay held');
 }
}

// ===== 7d. an unreadable readback after the writes is reported, never read as success =====
{
 const env={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};
 await call('hold',{generation:0,...EV},env);const id=identity(env);await call('import',{generation:1,...id},env);await call('activate',{generation:1,...id},env);await call('release',{generation:2,...id},env);
 sqlite(env.file,"UPDATE epg_ingest_status SET last_success_at='2026-11-21T16:12:00.000Z', revision=revision+1");
 await call('hold-rollback',{generation:2,...EV},env);
 let broken=false;
 const base=env.r2.read;
 const flaky={...base,async head(key){if(broken&&env.r2.puts.length>=2)throw new Error('unreadable');return base.head(key);}};
 const spy=env.r2.write;
 const writer=allowed=>{const store=spy(allowed);return {...store,async put(key,text,options){const result=await store.put(key,text,options);if(key==='watchlist-ingest.json')broken=true;return result;}};};
 const error=await stop(Op.execute('export-rollback',{generation:3,frozenSyncEtag:id.syncEtag,frozenIngestEtag:id.ingestEtag},{binding:env.db,readStore:flaky,writeStoreFactory:writer,now:NOW}),'readback_unreadable');
 assert.deepEqual(error.details.written,['sync.json','watchlist-ingest.json']);
 assert.deepEqual(marker(env.file),{mode:'d1',writes:'held',generation:3},'the marker does not move without a verified readback');
 // an unknown PUT outcome whose objects cannot be read is reported as unclassified
 const env2={...open('0030_epg_checkpoint_authority.sql'),r2:bucket(frozen)};
 await call('hold',{generation:0,...EV},env2);const id2=identity(env2);await call('import',{generation:1,...id2},env2);await call('activate',{generation:1,...id2},env2);await call('release',{generation:2,...id2},env2);
 sqlite(env2.file,"UPDATE epg_ingest_status SET last_success_at='2026-11-21T16:12:00.000Z', revision=revision+1");
 await call('hold-rollback',{generation:2,...EV},env2);
 let down=false;
 const flaky2={...env2.r2.read,async head(key){if(down)throw new Error('unreadable');return env2.r2.read.head(key);}};
 const lost=allowed=>({...env2.r2.write(allowed),async put(){down=true;throw new Error('lost reply');}});
 const unclassified=await stop(Op.execute('export-rollback',{generation:3,frozenSyncEtag:id2.syncEtag,frozenIngestEtag:id2.ingestEtag},{binding:env2.db,readStore:flaky2,writeStoreFactory:lost,now:NOW}),'write_uncertain');
 assert.equal(unclassified.details.classification,'unclassified');assert.equal(unclassified.details.observed,'unreadable');
}

// ===== 8. the script never deletes or resets: no such statement exists in it =====
{
 const source=fs.readFileSync('scripts/epg-checkpoint-production.mjs','utf8');
 assert.equal(/\bDELETE\s+FROM\b/i.test(source),false,'no D1 row is deleted by the operator');
 assert.equal(/\bDROP\s+TABLE\b/i.test(source),false);
 assert.equal(/\bepg_orchestration_document\b[^;]*\b(UPDATE|DELETE|INSERT)\b/i.test(source.replace(/SELECT[^'"]*epg_orchestration_document/g,'')),false,'the lease and control documents are only read');
 assert.equal(/watchOrchestration|resetLease|terminate|\.rollover/i.test(source),false);
}
console.log('epg-checkpoint-production: ok');
