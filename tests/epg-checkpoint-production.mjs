// The EPG checkpoint production operator (scripts/epg-checkpoint-production.mjs): exact transition contracts, drain proof, import parity, rollback export.
// Offline only: a sqlite D1 stand-in over the real migration chain and an in-memory R2 stand-in. No production database or bucket is opened.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Op from '../scripts/epg-checkpoint-production.mjs';
import * as Checkpoint from '../src/epg-checkpoint-d1.js';
import {createD1Adapter} from '../scripts/d1-backfill.mjs';import {createPublishedBinding} from '../scripts/published-epg-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-ckpt-op-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const sha=text=>createHash('sha256').update(text).digest('hex');
// 18:00 UTC on 20 Nov: after the natural run completed (16:12 UTC) and the same Madrid day, which is the H0 boundary of the plan.
const NOW=Date.parse('2026-11-20T18:00:00.000Z');
// The historical version of the finished instance is 'v-1' (control record); the deployed one is a different Worker version built from a commit that contains the routing.
const SHA='a'.repeat(40);
const EV={workflowInstanceId:'epg_20261120_1',workflowLiveness:'finished',deployedVersionId:'v-2',deployedCommit:SHA,deploymentVersions:'1',deploymentPercentage:'100',instancesChecked:'queued,running,waiting,paused,waitingForPause,rollingBack',instancesTotal:'0'};
// The git proof of the deployed commit is replaced here (CI clones may be shallow); the real function is tested on a temporary repository in section 12.
const exec=(command,args,deps)=>Op.execute(command,args,{...deps,ctx:{commitContains:()=>({ok:true}),...(deps.ctx||{})}});
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
const call=(command,args,env,options={})=>exec(command,args,{binding:env.db,readStore:env.r2.read,writeStoreFactory:env.r2.write,now:options.now??NOW,ctx:options.ctx??{}});
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

// ===== 2. apply: schema only; none of the cutover evidence; refuses only an executing EPG step =====
{
 // The schema-only apply copies nothing and switches nothing, so it needs no completed run of today, no Workflow evidence, no R2 identity and no matching version.
 assert.equal(Op.parseArgs(['node','x','--apply','--target','iptv','--confirm','apply']).command,'apply','apply parses without any evidence flag');
 const states=[];const trackedCtx=()=>({track:state=>states.push(state)});
 const NEXT_DAY=Date.parse('2026-11-21T08:00:00.000Z');
 for(const options of [{},{control:{runKey:'2026-11-19',versionId:'an-older-version',runId:'another-run'}},{nextWake:'2026-11-21T08:10:00.000Z',pause:'paused'},{finalized:null},{control:{instanceId:'another-instance'}}]){
  const env={...open('0029_started_authority.sql',options),r2:bucket(frozen)};
  let r2Calls=0;
  const counted={head:async()=>{r2Calls++;throw new Error('R2 must not be read');},get:async()=>{r2Calls++;throw new Error('R2 must not be read');}};
  states.length=0;
  const result=await exec('apply',{},{binding:env.db,readStore:counted,now:NEXT_DAY,ctx:trackedCtx()});
  assert.equal(result.writeState,'committed');assert.deepEqual(result.marker,{mode:'r2',writes:'open',generation:0,cas:1});
  assert.equal(rows(env.file,'SELECT version FROM schema_contract')[0].version,30);
  assert.equal(r2Calls,0,'apply never reads R2');assert.equal(env.r2.puts.length,0,'apply never writes R2');
  assert.deepEqual(counts(env.file),{run:0,body:0,film:0,ingest:0},'apply copies nothing');
  assert.equal(states.at(-1),'committed');
  // the cutover gates are untouched: with a stale run, version or no evidence a hold is still refused
  await stop(exec('hold',{generation:0,...EV},{binding:env.db,readStore:env.r2.read,now:NEXT_DAY}),'drain_refused');
 }
 // the one liveness rule: no executing EPG step
 for(const [options,busy] of [[{lease:'live'},'step_lease_live'],[{phase:'running'},'epg_phase_running'],[{phase:'starting'},'epg_phase_starting'],[{phase:'waiting'},'epg_phase_waiting']]){
  const env={...open('0029_started_authority.sql',options),r2:bucket(frozen)};
  states.length=0;
  const error=await stop(exec('apply',{},{binding:env.db,now:NOW,ctx:trackedCtx()}),'writer_active');
  assert.equal(error.details.busy,busy);
  assert.equal(rows(env.file,'SELECT version FROM schema_contract')[0].version,29,'a refused apply changes nothing');
  assert.equal(states.length,0,'refused before any write');
 }
 // wrong or partial schema
 const applied=open('0029_started_authority.sql');await exec('apply',{},{binding:applied.db,now:NOW});
 await stop(exec('apply',{},{binding:applied.db,now:NOW}),'already_applied');
 await stop(exec('apply',{},{binding:open('0028_filter_preset_authority.sql').db,now:NOW}),'schema_unexpected');
 const partial=open('0029_started_authority.sql');sqlite(partial.file,'CREATE TABLE epg_checkpoint_cas (id INTEGER PRIMARY KEY)');
 await stop(exec('apply',{},{binding:partial.db,now:NOW}),'partial_schema');
 // a failing statement: the file guards itself (exactly v29 with the started tables); the batch is atomic and the outcome is read back, never retried
 const broken=open('0029_started_authority.sql');sqlite(broken.file,'DROP TABLE started_mark');
 states.length=0;
 await stop(exec('apply',{},{binding:broken.db,now:NOW,ctx:trackedCtx()}),'statement_failed');
 assert.equal(rows(broken.file,'SELECT version FROM schema_contract')[0].version,29,'the failed apply left schema 29');
 assert.equal(rows(broken.file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'epg_checkpoint%'")[0].n,0,'and no table');
 assert.equal(states.at(-1),'none','the write state of a rolled-back apply is none');
 const v28={...open('0028_filter_preset_authority.sql'),r2:bucket(frozen)};
 await stop(call('hold',{generation:0,...EV},v28),'schema_unexpected');
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
// The production operator talks to D1 over REST, where a {batch} answers one result object per statement. The sqlite stand-in above
// returns rows from db.batch directly, which hid a binding that dropped them (AIR-551 H4a). This fetch serves the REST shape from the same file.
function restBinding(file,log=[]){
 const fetchImpl=async(url,init)=>{
  const body=JSON.parse(init.body);
  const entries=body.batch||[{sql:body.sql}];
  log.push({batch:Boolean(body.batch),selects:entries.every(e=>/^\s*select\b/i.test(e.sql))});
  const answer=(status,payload)=>({ok:status<400,status,json:async()=>payload});
  try{
   if(entries.every(e=>/^\s*select\b/i.test(e.sql))){
    return answer(200,{success:true,result:entries.map(e=>({success:true,results:rows(file,e.sql.replace(/;+\s*$/,'')),meta:{rows_written:0}}))});
   }
   sqlite(file,'BEGIN;\n'+entries.map(e=>e.sql).join('\n')+'\nCOMMIT;');
   return answer(200,{success:true,result:entries.map(()=>({success:true,results:[],meta:{rows_written:1}}))});
  }catch(error){return answer(400,{success:false,errors:[{message:String(error.message).slice(0,200)}]});}
 };
 const adapter=createD1Adapter({target:{endpoint:'https://rest.invalid',accountId:'a',apiToken:'t',maxBatchStatements:200,maxBatchBytes:4<<20},databaseId:'db',fetchImpl,retries:0,sleep:async()=>{}});
 return createPublishedBinding(adapter);
}

async function sequence(upTo){
 const env={...open(upTo),r2:bucket(frozen)};
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
 await stop(exec('activate',{generation:1,...id},{binding:env.db,readStore:moved.read,now:NOW}),'identity_mismatch');
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
// The same forward and rollback sequence on every schema level that keeps the 0030 contract: 30, 31 (the Watchlist authority) and the latest.
for(const upTo of ['0030_epg_checkpoint_authority.sql','0031_watchlist_authority.sql','9999'])await sequence(upTo);

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
 // without the ingest object the hold itself refuses: the import would refuse that checkpoint, so nothing is frozen for it
 const notImportable=await stop(call('hold',{generation:0,...EV},none),'drain_refused');
 assert.ok(notImportable.details.failures.includes('r2_checkpoint_not_importable'));
 assert.deepEqual(marker(none.file),{mode:'r2',writes:'open',generation:0});
 const idNone={syncEtag:none.r2.objects.get('sync.json').etag,syncSha256:sha(SYNC_RAW)};
 await stop(call('import',{generation:0,...idNone,ingestEtag:'x',ingestSha256:'y'},none),'state_mismatch');
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
 // the historical version of the finished instance is evidence and must be known; the deployed version is NOT compared with it (section 11)
 const noVersion=base();sqlite(noVersion.file,"UPDATE epg_orchestration_document SET body=json_remove(body,'$.versionId') WHERE key='control'");
 await refused(EV,'control_version_unknown',{env:noVersion});
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
 const failed=await stop(exec('hold',{generation:0,...EV},{binding:unreadable.db,readStore:brokenRead,now:NOW}),'drain_refused');assert.ok(failed.details.failures.includes('event_debt_unreadable'),'an unreadable journal check is fail-closed');
 // drift between the status read and the hold: each record the proof was read from is re-asserted inside the marker batch
 const drift=async mutate=>{
  const env=base();
  const state=await Op.readState(env.db);
  const proof=Op.proofFacts(state);
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
 const error=await stop(exec('export-rollback',{generation:3,frozenSyncEtag:id.syncEtag,frozenIngestEtag:id.ingestEtag},{binding:env.db,readStore:flaky,writeStoreFactory:writer,now:NOW}),'readback_unreadable');
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
 const unclassified=await stop(exec('export-rollback',{generation:3,frozenSyncEtag:id2.syncEtag,frozenIngestEtag:id2.ingestEtag},{binding:env2.db,readStore:flaky2,writeStoreFactory:lost,now:NOW}),'write_uncertain');
 assert.equal(unclassified.details.classification,'unclassified');assert.equal(unclassified.details.observed,'unreadable');
}

// ===== 9. schema gates after the apply: any schema from 30 on that keeps the 0030 contract; nothing else =====
{
 const refused=async(label,mutate,command='hold')=>{
  const env={...open('9999'),r2:bucket(frozen)};
  mutate(env.file);
  await stop(exec(command,{generation:0,...EV},{binding:env.db,readStore:env.r2.read,now:NOW}),'schema_unexpected');
  const after=marker(env.file);
  if(after&&after.mode==='r2')assert.deepEqual(after,{mode:'r2',writes:'open',generation:0},label+': nothing changed');
 };
 await refused('a missing trigger',file=>sqlite(file,'DROP TRIGGER epg_checkpoint_run_order'));
 await refused('the other trigger',file=>sqlite(file,'DROP TRIGGER epg_checkpoint_cas_required'));
 await refused('a missing table',file=>sqlite(file,'DROP TABLE epg_ingest_status'));
 await refused('no marker row',file=>sqlite(file,'DELETE FROM epg_checkpoint_authority'));
 await refused('an unreadable marker mode',file=>sqlite(file,'PRAGMA ignore_check_constraints=ON;UPDATE epg_checkpoint_authority SET mode=\'x\''),'import');
 await refused('a schema below 30 that still has the tables',file=>sqlite(file,'DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=29 WHERE id=1'));
 await refused('a schema below 30 without the tables',file=>sqlite(file,'DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=29 WHERE id=1;DROP TABLE epg_ingest_status'),'activate');
 // the apply knows an installed contract at every level
 for(const upTo of ['0030_epg_checkpoint_authority.sql','0031_watchlist_authority.sql','9999']){
  const installed=open(upTo);
  await stop(exec('apply',{},{binding:installed.db,now:NOW}),'already_applied');
 }
 // a status read at the latest schema reports it and is still read-only
 const latest=open('9999');
 const status=await exec('status',{...EV},{binding:latest.db,readStore:bucket(frozen).read,now:NOW});
 assert.equal(status.writes,false);assert.equal(status.schemaVersion,Number(names.at(-1).slice(0,4)));assert.ok(status.schemaVersion>=32);
}

// ===== 10. the next EPG start comes from the shared schedule and is fail-closed =====
{
 const at=text=>Date.parse(text);const iso=ms=>new Date(ms).toISOString();
 // the daily due time is 17:00 Europe/Madrid: 16:00 UTC in winter, 15:00 UTC in summer; once today's has passed the next start is tomorrow's, never today's (in the past)
 assert.equal(iso(Op.nextStartAfter(at('2026-11-20T18:00:00Z'))),'2026-11-21T16:00:00.000Z');
 assert.equal(iso(Op.nextStartAfter(at('2026-11-21T16:00:00Z'))),'2026-11-22T16:00:00.000Z','at the due instant the next start is tomorrow');
 assert.equal(iso(Op.nextStartAfter(at('2026-11-21T15:59:59Z'))),'2026-11-21T16:00:00.000Z');
 assert.equal(iso(Op.nextStartAfter(at('2026-07-10T10:00:00Z'))),'2026-07-10T15:00:00.000Z','summer');
 assert.equal(iso(Op.nextStartAfter(at('2026-07-10T16:00:00Z'))),'2026-07-11T15:00:00.000Z');
 // daylight saving: 29 Mar 2026 (clocks forward) and 25 Oct 2026 (clocks back)
 assert.equal(iso(Op.nextStartAfter(at('2026-03-28T16:30:00Z'))),'2026-03-29T15:00:00.000Z');
 assert.equal(iso(Op.nextStartAfter(at('2026-10-24T16:30:00Z'))),'2026-10-25T16:00:00.000Z');
 const spring=at('2026-03-29T14:45:00Z'),autumn=at('2026-10-25T15:45:00Z');
 assert.equal(Op.nextStartAfter(spring)-spring,15*60000,'spring: 15 minutes to the start (a fixed 16:00 UTC rule would say 75)');
 assert.equal(Op.nextStartAfter(autumn)-autumn,15*60000,'autumn: 15 minutes to the start (a fixed 15:00 UTC rule would say it had passed)');
 // the proof: unknown, expired and too close refuse; a start far enough away passes
 const env={...open('9999'),r2:bucket(frozen)};
 const state=await Op.readState(env.db);
 const run=JSON.parse(SYNC);
 const failures=nextStart=>Op.drainProof(state,{run,now:NOW,evidence:{...EV,commitContainsRouting:true},nextStart}).failures;
 assert.ok(failures(null).includes('next_start_unknown'));
 assert.ok(failures(Number.NaN).includes('next_start_unknown'));
 assert.ok(failures(undefined).includes('next_start_unknown')===false,'an omitted value takes the computed start');
 assert.ok(failures(NOW-1).includes('next_start_too_close'),'an expired start is not a margin');
 assert.ok(failures(NOW+10*60000).includes('next_start_too_close'));
 assert.ok(failures(NOW+29*60000).includes('next_start_too_close'));
 assert.equal(failures(NOW+31*60000).some(code=>code.startsWith('next_start')),false);
 assert.equal(Op.drainProof(state,{run,now:NOW,evidence:{...EV,commitContainsRouting:true}}).ok,true,'the same-day state with the computed start passes');
 // the command: refused 15 minutes before the due time, with every other gate passing
 const early={...open('9999'),r2:bucket(frozen)};
 const tooClose=await stop(exec('hold',{generation:0,...EV},{binding:early.db,readStore:early.r2.read,now:at('2026-11-20T15:45:00Z')}),'drain_refused');
 assert.deepEqual(tooClose.details.failures,['next_start_too_close'],'only the margin refuses');
 assert.deepEqual(marker(early.file),{mode:'r2',writes:'open',generation:0});
 // after today's due time the next start is tomorrow's, so a hold is possible
 const later={...open('9999'),r2:bucket(frozen)};
 const held=await exec('hold',{generation:0,...EV},{binding:later.db,readStore:later.r2.read,now:at('2026-11-20T16:30:00Z')});
 assert.deepEqual(held.marker,{mode:'r2',writes:'held',generation:1});
 // the status shows the computed start
 const shown=await exec('status',{...EV},{binding:env.db,readStore:env.r2.read,now:NOW});
 assert.equal(shown.nextStart.at,'2026-11-21T16:00:00.000Z');assert.equal(shown.nextStart.inMinutes,22*60);
}

// ===== 11. the deployed version is not compared with the finished instance's; nothing that could write may run =====
{
 const base=()=>({...open('9999'),r2:bucket(frozen)});
 const refusedWith=async(args,failure,options={})=>{
  const env=options.env??base();
  const error=await stop(exec('hold',{generation:0,...EV,...args},{binding:env.db,readStore:env.r2.read,now:NOW,ctx:options.ctx}),'drain_refused');
  assert.ok(error.details.failures.includes(failure),failure+' in '+error.details.failures);
  assert.deepEqual(marker(env.file),{mode:'r2',writes:'open',generation:0},failure+': nothing changed');
 };
 // positive: the finished instance ran 'v-1' (control record), the deployed Worker is 'v-2' from a commit that contains the routing; the historical version stays untouched and pinned
 const env=base();
 const state=await Op.readState(env.db);
 assert.equal(state.orchestration.control.body.versionId,'v-1');assert.notEqual(EV.deployedVersionId,'v-1');
 assert.equal(Op.proofFacts(state).versionId,'v-1','the batch pins the historical version of the control record, not the deployed one');
 const held=await exec('hold',{generation:0,...EV},{binding:env.db,readStore:env.r2.read,now:NOW});
 assert.deepEqual(held.marker,{mode:'r2',writes:'held',generation:1});
 assert.equal(rows(env.file,"SELECT json_extract(body,'$.versionId') AS v FROM epg_orchestration_document WHERE key='control'")[0].v,'v-1','the historical version is not rewritten');
 // missing deployment evidence refuses, each field
 for(const field of ['deployedVersionId','deployedCommit','deploymentVersions','deploymentPercentage'])await refusedWith({[field]:undefined},'deployment_evidence_missing');
 // contradictory or mixed deployments
 await refusedWith({deploymentVersions:'2'},'deployment_not_single_full');
 await refusedWith({deploymentPercentage:'50'},'deployment_not_single_full');
 await refusedWith({deploymentVersions:'2',deploymentPercentage:'60'},'deployment_not_single_full');
 // a deployed commit that does not contain the routing, or that cannot be proven locally, is not compatible
 await refusedWith({},'deployed_commit_incompatible',{ctx:{commitContains:()=>({ok:false,reason:'not_a_descendant'})}});
 await refusedWith({},'deployed_commit_incompatible',{ctx:{commitContains:()=>({ok:false,reason:'commit_unknown_locally'})}});
 await refusedWith({},'deployed_commit_incompatible',{ctx:{commitContains:()=>({})}});
 // the inventory of the non-terminal instances: every status, complete, none found
 await refusedWith({instancesChecked:'queued,running,waiting,paused,waitingForPause'},'instances_inventory_incomplete');
 await refusedWith({instancesChecked:'queued,running,waiting,paused,waitingForPause,rollingBack,complete'},'instances_inventory_incomplete');
 await refusedWith({instancesChecked:undefined},'instances_inventory_incomplete');
 await refusedWith({instancesTotal:undefined},'instances_inventory_incomplete');
 await refusedWith({instancesTotal:'x'},'instances_inventory_incomplete');
 await refusedWith({instancesTotal:'1'},'workflow_instances_active');
 await refusedWith({instancesTotal:'3'},'workflow_instances_active');
 // the status of the instance itself and the orchestration mode
 await refusedWith({workflowLiveness:'running'},'workflow_not_terminal');
 await refusedWith({workflowInstanceId:undefined},'workflow_evidence_missing');
 const external=base();sqlite(external.file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.mode','external') WHERE key='mode'");
 await refusedWith({},'orchestration_mode_not_cloudflare',{env:external});
 // a stored R2 checkpoint that the import would refuse stops the hold, and status says so
 const broken=bucket({...frozen,'sync.json':JSON.stringify({...JSON.parse(SYNC),stage:'seal',seal:{phase:'ledger'}})});
 const brokenEnv={...base(),r2:broken};
 await refusedWith({},'r2_checkpoint_not_importable',{env:brokenEnv});
 assert.equal((await exec('status',{...EV},{binding:base().db,readStore:base().r2.read,now:NOW})).r2.importable,true);
 assert.equal((await exec('status',{...EV},{binding:brokenEnv.db,readStore:broken.read,now:NOW})).r2.importable,false);
 // the same rules for the rollback hold: a D1-mode, idle, complete run, with its own historical version
 const rollbackEnv={...open('9999'),r2:bucket(frozen)};
 await exec('hold',{generation:0,...EV},{binding:rollbackEnv.db,readStore:rollbackEnv.r2.read,now:NOW});
 const id=identity(rollbackEnv);
 await exec('import',{generation:1,...id},{binding:rollbackEnv.db,readStore:rollbackEnv.r2.read,now:NOW});
 await exec('activate',{generation:1,...id},{binding:rollbackEnv.db,readStore:rollbackEnv.r2.read,now:NOW});
 await exec('release',{generation:2,...id},{binding:rollbackEnv.db,readStore:rollbackEnv.r2.read,now:NOW});
 const rollbackRefused=async(args,failure,options={})=>{
  const error=await stop(exec('hold-rollback',{generation:2,...EV,...args},{binding:rollbackEnv.db,readStore:rollbackEnv.r2.read,now:NOW,ctx:options.ctx}),'drain_refused');
  assert.ok(error.details.failures.includes(failure),failure);
  assert.deepEqual(marker(rollbackEnv.file),{mode:'d1',writes:'open',generation:2},failure+': nothing changed');
 };
 await rollbackRefused({instancesTotal:'1'},'workflow_instances_active');
 await rollbackRefused({instancesChecked:'queued,running'},'instances_inventory_incomplete');
 await rollbackRefused({deploymentPercentage:'50'},'deployment_not_single_full');
 await rollbackRefused({deployedCommit:undefined},'deployment_evidence_missing');
 await rollbackRefused({},'deployed_commit_incompatible',{ctx:{commitContains:()=>({ok:false})}});
 await rollbackRefused({workflowLiveness:'waiting'},'workflow_not_terminal');
 const rolled=await exec('hold-rollback',{generation:2,...EV},{binding:rollbackEnv.db,readStore:rollbackEnv.r2.read,now:NOW});
 assert.deepEqual(rolled.marker,{mode:'d1',writes:'held',generation:3},'a different deployed version does not stop the rollback hold');
 // changed control, lease and certificate between the proof and the marker batch refuse (the batch re-asserts them); each is also covered in section 7b
 const raced=base();
 const proof=Op.proofFacts(await Op.readState(raced.db));
 sqlite(raced.file,"UPDATE epg_orchestration_document SET revision=revision+1 WHERE key='control'");
 await stop(Op.transition(raced.db,'hold',{generation:0,now:NOW,proof}),'predicate_refused');
 assert.deepEqual(marker(raced.file),{mode:'r2',writes:'open',generation:0});
}

// ===== 12. the git proof of the deployed commit, on a temporary repository =====
{
 const repo=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-git-proof-'));
 const env={...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.com'};
 const git=(...args)=>{const result=spawnSync('git',args,{cwd:repo,encoding:'utf8',env});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
 git('init','-q','-b','main');
 const commit=text=>{fs.writeFileSync(path.join(repo,'f.txt'),text);git('add','f.txt');git('commit','-q','-m',text);return git('rev-parse','HEAD');};
 const A=commit('a'),B=commit('b');
 git('checkout','-q','-b','side',A);const C=commit('c');
 assert.deepEqual(Op.commitContains(B,A,repo),{ok:true},'a descendant contains its ancestor');
 assert.deepEqual(Op.commitContains(A,A,repo),{ok:true},'a commit contains itself');
 assert.deepEqual(Op.commitContains(C,A,repo),{ok:true},'a commit on another branch that has the ancestor');
 assert.equal(Op.commitContains(A,B,repo).reason,'not_a_descendant','an older commit does not contain a newer one');
 assert.equal(Op.commitContains(C,B,repo).reason,'not_a_descendant','an unrelated branch does not contain it');
 assert.equal(Op.commitContains('f'.repeat(40),A,repo).reason,'commit_unknown_locally','a commit that is not in the local history is unknown, not compatible');
 assert.equal(Op.commitContains(B,'e'.repeat(40),repo).reason,'routing_commit_unknown_locally');
 for(const bad of ['','abc',undefined,null,A.toUpperCase(),A+'0',A.slice(0,39),'--all',B+'\n'])assert.equal(Op.commitContains(bad,A,repo).reason,'commit_invalid',String(bad));
 assert.match(Op.ROUTING_COMMIT,/^[0-9a-f]{40}$/);
 assert.deepEqual([...Op.WORKFLOW_STATUSES],['paused','queued','rollingBack','running','waiting','waitingForPause'],'the six non-terminal statuses the inventory must list');
}

// ===== 8. the script never deletes or resets: no such statement exists in it =====
{
 const source=fs.readFileSync('scripts/epg-checkpoint-production.mjs','utf8');
 assert.equal(/\bDELETE\s+FROM\b/i.test(source),false,'no D1 row is deleted by the operator');
 assert.equal(/\bDROP\s+TABLE\b/i.test(source),false);
 assert.equal(/\bepg_orchestration_document\b[^;]*\b(UPDATE|DELETE|INSERT)\b/i.test(source.replace(/SELECT[^'"]*epg_orchestration_document/g,'')),false,'the lease and control documents are only read');
 assert.equal(/watchOrchestration|resetLease|terminate|\.rollover/i.test(source),false);
}
// Regression: the whole forward path and the read-back of every command over the REST-shaped binding.
{
 const env={...open(),r2:bucket(frozen)};
 const log=[];const rest={...env,db:restBinding(env.file,log)};
 await call('hold',{generation:0,...EV},rest);
 await call('import',{generation:1,...identity(rest)},rest);
 const activated=await call('activate',{generation:1,...identity(rest)},rest);
 assert.deepEqual(activated.marker,{mode:'d1',writes:'held',generation:2},'activate reads the run back through the REST binding');
 const loaded=await Checkpoint.loadRun(rest.db);
 assert.equal(loaded.ok,true);assert.equal(loaded.run.stage,'complete');
 const ingest=await Checkpoint.readIngest(rest.db);assert.ok(ingest);
 const released=await call('release',{generation:2,...identity(rest)},rest);
 assert.deepEqual(released.marker,{mode:'d1',writes:'open',generation:2});
 assert.ok(log.some(e=>e.batch&&e.selects),'the repository reads went out as read-only batches');
 await assert.rejects(()=>restBinding(env.file).batch([{text:"SELECT 1; DELETE FROM epg_checkpoint_run"}]),e=>e.code==='statement'||e.reason==='batch_too_large'||/SELECT/.test(String(e.message)),'a batch that is not SELECT-only never takes the read path');
}

console.log('epg-checkpoint-production: ok');
