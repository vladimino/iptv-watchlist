import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {BATCH_BYTES, createCacheBinding, migrationStatements, PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID, runMetadataCacheProduction, STATEMENT_BYTES} from '../scripts/metadata-cache-production.mjs';

const SCRATCH_ID='00000000-0000-4000-8000-000000000001';
const NOW=Date.parse('2026-11-01T10:00:00.000Z');
const TOKEN='test-token-value';
const SECRET='test-secret-value';
const SENTINEL='TITLE_SENTINEL';
const script=path.resolve('scripts/metadata-cache-production.mjs');
const roots=[];

function sql(file, input, {json=false}={}){
 const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8',maxBuffer:1<<26});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
 if(!json)return result.stdout;
 const text=result.stdout.trim();
 return text?JSON.parse(text):[];
}
function applyMigrations(file, count){
 const names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'];
 for(const name of names.slice(0,count)){
  const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/'+name+'.sql','utf8'),encoding:'utf8'});
  if(result.status!==0)throw new Error(name+'\n'+result.stderr);
 }
}
function baseEnv(overrides={}){
 return {
  D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,
  D1_BACKFILL_API_TOKEN:TOKEN,
  D1_BACKFILL_SCRATCH_DATABASE_ID:SCRATCH_ID,
  R2_SNAPSHOT_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,
  R2_SNAPSHOT_ACCESS_KEY_ID:'test-access',
  R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,
  R2_SNAPSHOT_BUCKET:'iptv',
  R2_SNAPSHOT_ENDPOINT:'http://127.0.0.1',
  ...overrides,
 };
}
function responseJson(payload, status=200){
 return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
}
async function install(options={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'air313-'));
 roots.push(root);
 const productionFile=path.join(root,'production.sqlite');
 const scratchFile=path.join(root,'scratch.sqlite');
 sql(productionFile,'PRAGMA user_version=0;');
 sql(scratchFile,'PRAGMA user_version=0;');
 if(options.schema)applyMigrations(productionFile, options.schema);
 const objects=new Map();
 const state={loseWrite:!!options.loseWrite, race:!!options.race, flipAfterImport:!!options.flipAfterImport, seenGet:false, imported:false, atomicScratch:options.atomicScratch!==false, afterWrite:options.afterWrite||null, armed:null};
 const calls={urls:[], batches:[]};
 const described={uuid:options.uuid||PRODUCTION_DATABASE_ID, name:options.name||'iptv', scratchName:options.scratchName||'scratch'};
 function putObject(key, value){
  const text=typeof value==='string'?value:JSON.stringify(value);
  objects.set(key,{text, etag:createHash('sha256').update(text).digest('hex').slice(0,32)});
 }
 function runRead(file, statement){
  if(state.armed){
   const armed=state.armed;
   state.armed=null;
   if(armed==='apply-version')return responseJson({success:true,result:[{success:true,results:[{version:5}]}]});
   if(armed==='load-empty')return responseJson({success:true,result:[{success:true,results:[]}]});
   if(armed==='activate-stale')return responseJson({success:true,result:[{success:true,results:[{mode:'r2',cacheGeneration:1,mirrorGeneration:1,mirrorEtag:'stale'}]}]});
  }
  const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+statement,encoding:'utf8',maxBuffer:1<<26});
  if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
  const text=result.stdout.trim();
  return responseJson({success:true,result:[{success:true,results:text?JSON.parse(text):[]}]});
 }
 function runBatch(file, statements, atomic){
  if(!atomic){
   const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+statements.join('\n'),encoding:'utf8',maxBuffer:1<<26});
   if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
   return responseJson({success:true,result:statements.map(()=>({success:true,results:[]}))});
  }
  const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+statements.join('\n')+'\nCOMMIT;\n',encoding:'utf8',maxBuffer:1<<26});
  if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
  return responseJson({success:true,result:statements.map(()=>({success:true,results:[]}))});
 }
 async function fetchImpl(url, init={}){
  const target=new URL(url);
  calls.urls.push(target.pathname+(target.search||''));
  if(target.pathname.includes('time_travel/restore'))return new Response('no',{status:403});
  const database=target.pathname.match(/\/d1\/database\/([^/]+)(?:\/(.*))?$/);
  if(database){
   const id=database[1], rest=database[2]||'';
   const file=id===PRODUCTION_DATABASE_ID?productionFile:id===SCRATCH_ID?scratchFile:null;
   if(!file)return responseJson({success:false,errors:[{message:'unknown database'}]},404);
   if((init.method||'GET')==='GET'&&rest==='')return responseJson({success:true,result:{uuid:id===PRODUCTION_DATABASE_ID?described.uuid:id,name:id===PRODUCTION_DATABASE_ID?described.name:described.scratchName}});
   if((init.method||'GET')==='GET'&&rest==='time_travel/bookmark')return responseJson({success:true,result:{bookmark:'bookmark-before-image'}});
   if((init.method||'GET')!=='POST'||rest!=='query')return responseJson({success:false},404);
   const body=JSON.parse(init.body);
   if(body.batch){
    calls.batches.push({id, body:init.body});
    if(id===PRODUCTION_DATABASE_ID&&state.loseWrite){state.loseWrite=false;throw new Error('socket hang up');}
    if(id===PRODUCTION_DATABASE_ID&&state.afterWrite){state.armed=state.afterWrite;state.afterWrite=null;}
    if(body.batch.some(item=>/INSERT\s+INTO\s+metadata_cache\b/i.test(item.sql)))state.imported=true;
    return runBatch(file, body.batch.map(item=>item.sql), id===SCRATCH_ID?state.atomicScratch:true);
   }
   if(typeof body.sql==='string')return runRead(file, body.sql);
   return responseJson({success:false},400);
  }
  if(!target.pathname.startsWith('/iptv/'))return new Response('no',{status:404});
  const key=decodeURIComponent(target.pathname.slice('/iptv/'.length));
  const method=init.method||'GET';
  if(method==='HEAD'&&key==='metadata.json'&&state.race&&state.seenGet){state.race=false;return new Response(null,{status:412});}
  if(method==='HEAD'&&key==='metadata.json'&&state.flipAfterImport&&state.imported){state.flipAfterImport=false;return new Response(null,{status:412});}
  const object=objects.get(key);
  if(!object)return new Response(null,{status:404});
  const ifMatch=String(new Headers(init.headers||{}).get('if-match')||'').replaceAll('"','');
  if(ifMatch&&ifMatch!==object.etag)return new Response(null,{status:412});
  if(method==='GET'&&key==='metadata.json')state.seenGet=true;
  const headers={'etag':'"'+object.etag+'"','content-length':String(Buffer.byteLength(object.text)),'content-type':'application/json'};
  if(method==='HEAD')return new Response(null,{status:200,headers});
  if(method==='GET')return new Response(object.text,{status:200,headers});
  return new Response('no',{status:403});
 }
 return {root, productionFile, scratchFile, putObject, fetchImpl, calls, objects, state};
}
function argv(args){return ['node','metadata-cache-production.mjs',...args];}
async function execute(args, installed, overrides={}){
 return runMetadataCacheProduction({argv:argv(args), env:baseEnv(overrides), fetchImpl:installed.fetchImpl, now:()=>NOW});
}
function productionBatches(calls){return calls.batches.filter(item=>item.id===PRODUCTION_DATABASE_ID);}
function assertQuiet(result){
 const text=JSON.stringify(result);
 assert.equal(text.includes(TOKEN),false);
 assert.equal(text.includes(SECRET),false);
 assert.equal(text.includes(SENTINEL),false);
}
function metadataBody(){
 return {heat:{metadataAt:'2020-01-01T00:00:00.000Z',synopsisFetchedAt:null,peopleNamesVersion:2,extra:null,note:"a;b'c",secretTitle:SENTINEL},orphan:{metadataAt:'2020-01-01T00:00:00.000Z'}};
}

const bare=spawnSync(process.execPath,[script],{encoding:'utf8'});
assert.equal(bare.status,0,bare.stderr);
assert.deepEqual(JSON.parse(bare.stdout),{configured:false,writes:false,writeState:'none'});
const revert=spawnSync(process.execPath,[script,'--revert','--target','iptv'],{encoding:'utf8'});
assert.equal(revert.status,2);
assert.match(revert.stderr,/refuse: revert_refused/);
const missingConfirm=spawnSync(process.execPath,[script,'--apply','--target','iptv'],{encoding:'utf8'});
assert.equal(missingConfirm.status,2);
assert.match(missingConfirm.stderr,/confirm/);
const badTarget=spawnSync(process.execPath,[script,'--load','--confirm','load','--target','other'],{encoding:'utf8'});
assert.equal(badTarget.status,2);
assert.match(badTarget.stderr,/target_invalid/);

{
 let called=false;
 const binding=createCacheBinding({get(){called=true;},all(){called=true;},run(){called=true;},executeRendered(){called=true;}});
 assert.throws(()=>binding.prepare('SELECT '+Array.from({length:101},()=>'?').join(',')).bind(...Array.from({length:101},()=>1)),error=>error.reason==='batch_too_large');
 await binding.batch([{text:'x'.repeat(STATEMENT_BYTES+1)}]).then(()=>assert.fail('oversized statement was sent'),error=>assert.equal(error.reason,'batch_too_large'));
 assert.equal(called,false);
 assert.ok(BATCH_BYTES>1024*1024);
}

{
 const refused=await runMetadataCacheProduction({argv:argv(['--load','--target','iptv','--confirm','apply']),env:baseEnv(),fetchImpl(){throw new Error('called');},now:()=>NOW});
 assert.equal(refused.exit,2);
 assert.equal(refused.result.reason,'confirm');
 const account=await runMetadataCacheProduction({argv:argv(['--target','iptv']),env:baseEnv({D1_BACKFILL_ACCOUNT_ID:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}),fetchImpl(){throw new Error('called');},now:()=>NOW});
 assert.equal(account.exit,3);
 assert.equal(account.result.reason,'account_mismatch');
 const database=await runMetadataCacheProduction({argv:argv(['--target','iptv']),env:baseEnv({D1_BACKFILL_DATABASE_ID:'00000000-0000-4000-8000-000000000099'}),fetchImpl(){throw new Error('called');},now:()=>NOW});
 assert.equal(database.exit,3);
 assert.equal(database.result.reason,'database_id_mismatch');
 let calls=0;
 const fetchImpl=(url,init={})=>{calls++;const header=new Headers(init.headers||{}).get('authorization')||'';if(header.includes(TOKEN))throw new Error('token sent');throw new Error('called '+url);};
 for(const endpoint of ['https://evil.example','http://127.0.0.1','http://127.0.0.1:8787','https://api.cloudflare.com','https://api.cloudflare.com/client/v4/extra','https://user:'+TOKEN+'@evil.example/client/v4']){
  const refusedEndpoint=await runMetadataCacheProduction({argv:argv(['--target','iptv']),env:baseEnv({D1_BACKFILL_ENDPOINT:endpoint}),fetchImpl,now:()=>NOW});
  assert.equal(refusedEndpoint.exit,3,endpoint);
  assert.equal(refusedEndpoint.result.reason,'endpoint_refused');
  assert.equal(refusedEndpoint.result.writes,false);
  assert.equal(refusedEndpoint.result.writeState,'none');
  const text=JSON.stringify(refusedEndpoint.result);
  assert.equal(text.includes(TOKEN),false,endpoint);
  assert.equal(text.includes('evil.example'),false,endpoint);
 }
 assert.equal(calls,0);
}

{
 const wrongName=await install({schema:5,name:'other'});
 wrongName.putObject('metadata.json',metadataBody());
 const outcome=await execute(['--target','iptv'],wrongName);
 assert.equal(outcome.exit,3,JSON.stringify(outcome.result));
 assert.equal(outcome.result.reason,'target_identity_mismatch');
 assert.equal(wrongName.calls.batches.length,0);
 assert.equal(wrongName.calls.urls.some(url=>url.includes('/query')||url.includes('time_travel')),false);
 const wrongUuid=await install({schema:5,uuid:'00000000-0000-4000-8000-000000000099'});
 const mismatched=await execute(['--target','iptv'],wrongUuid);
 assert.equal(mismatched.exit,3);
 assert.equal(mismatched.result.reason,'target_identity_mismatch');
 assert.equal(wrongUuid.calls.batches.length,0);
}

{
 const installed=await install({schema:5});
 installed.putObject('metadata.json',metadataBody());
 installed.putObject('sync.json',{stage:'metadata',updatedAt:new Date(NOW-16*60*1000).toISOString()});
 const status=await execute(['--target','iptv'],installed);
 assert.equal(status.exit,0,JSON.stringify(status.result));
 assert.equal(status.result.writes,false);
 assert.equal(status.result.schemaVersion,5);
 assert.equal(status.result.tables.metadata_cache,false);
 assert.equal(status.result.bookmark,'bookmark-before-image');
 assert.equal(status.result.r2.metadata.keys,2);
 assert.equal(status.result.writers.sync,'idle');
 assert.equal(status.result.writers.projection,'idle');
 assert.equal(status.result.writeState,'none');
 assertQuiet(status.result);
 const canonical=await execute(['--target','iptv'],installed,{D1_BACKFILL_ENDPOINT:'https://api.cloudflare.com/client/v4/'});
 assert.equal(canonical.exit,0,JSON.stringify(canonical.result));
 assert.equal(canonical.result.schemaVersion,5);
 assert.equal(installed.calls.urls.some(url=>url.includes('/d1/database/')),true);
 assert.equal(installed.calls.urls.some(url=>url.includes('time_travel/restore')),false);
 const bareD1=await install({schema:5});
 const unconfigured=await execute(['--target','iptv'],bareD1,{R2_SNAPSHOT_ACCOUNT_ID:'',R2_SNAPSHOT_ACCESS_KEY_ID:'',R2_SNAPSHOT_SECRET_ACCESS_KEY:'',R2_SNAPSHOT_BUCKET:''});
 assert.equal(unconfigured.exit,0,JSON.stringify(unconfigured.result));
 assert.equal(unconfigured.result.r2,'not_configured');
 const absent=await install({schema:5});
 const missing=await execute(['--target','iptv'],absent);
 assert.equal(missing.exit,3,JSON.stringify(missing.result));
 assert.equal(missing.result.reason,'source_missing');
 assert.equal(productionBatches(absent.calls).length,0);
}

{
 const installed=await install({schema:5});
 installed.putObject('metadata.json',metadataBody());
 const applied=await execute(['--target','iptv','--apply','--confirm','apply'],installed);
 assert.equal(applied.exit,0,JSON.stringify(applied.result));
 assert.equal(applied.result.mode,'r2');
 assert.equal(applied.result.cacheGeneration,0);
 assert.equal(applied.result.mirrorGeneration,0);
 assert.equal(applied.result.cacheRows,0);
 assert.equal(applied.result.schemaVersion,6);
 assertQuiet(applied.result);
 const batches=productionBatches(installed.calls);
 assert.equal(batches.length,1);
 const sent=JSON.parse(batches[0].body);
 assert.deepEqual(Object.keys(sent),['batch']);
 const statements=sent.batch.map(item=>{assert.deepEqual(Object.keys(item),['sql']);return item.sql.replace(/;\s*$/,'');});
 assert.deepEqual(statements,migrationStatements(fs.readFileSync('migrations/0006_metadata_cache.sql','utf8')));
 assert.equal(statements.join('\n').includes('film_sync_state'),false);
 assert.equal(installed.calls.urls.some(url=>url.includes(SCRATCH_ID)),false);
 assert.equal(sql(installed.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,6);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM metadata_cache;',{json:true})[0].n,0);
 const again=await execute(['--target','iptv','--apply','--confirm','apply'],installed);
 assert.equal(again.exit,3,JSON.stringify(again.result));
 assert.equal(again.result.reason,'already_applied');
 assert.equal(productionBatches(installed.calls).length,1);
 const active=await install({schema:5});
 active.putObject('metadata.json',metadataBody());
 active.putObject('sync.json',{stage:'metadata',updatedAt:new Date(NOW).toISOString()});
 const busy=await execute(['--target','iptv','--apply','--confirm','apply'],active);
 assert.equal(busy.exit,3,JSON.stringify(busy.result));
 assert.equal(busy.result.reason,'writer_active');
 assert.equal(busy.result.writeState,'none');
 assert.equal(busy.result.writes,false);
 assert.equal(productionBatches(active.calls).length,0);
 const leased=await install({schema:5});
 leased.putObject('metadata.json',metadataBody());
 sql(leased.productionFile,"INSERT INTO projection_run (projection,lease_until) VALUES ('enrichment','2099-01-01T00:00:00.000Z');");
 const held=await execute(['--target','iptv','--apply','--confirm','apply'],leased);
 assert.equal(held.exit,3,JSON.stringify(held.result));
 assert.equal(held.result.reason,'writer_active');
 assert.equal(productionBatches(leased.calls).length,0);
 const lost=await install({schema:5,loseWrite:true});
 lost.putObject('metadata.json',metadataBody());
 const uncertain=await execute(['--target','iptv','--apply','--confirm','apply'],lost);
 assert.equal(uncertain.exit,3,JSON.stringify(uncertain.result));
 assert.equal(uncertain.result.reason,'write_uncertain');
 assert.equal(uncertain.result.writeState,'unknown');
 assert.equal(uncertain.result.writes,null);
 assert.equal(uncertain.result.retry,false);
 assert.equal(uncertain.result.readback.schemaVersion,5);
 assert.equal(productionBatches(lost.calls).length,1);
 assert.equal(sql(lost.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,5);
 const lied=await install({schema:5,afterWrite:'apply-version'});
 lied.putObject('metadata.json',metadataBody());
 const mismatch=await execute(['--target','iptv','--apply','--confirm','apply'],lied);
 assert.equal(mismatch.exit,3,JSON.stringify(mismatch.result));
 assert.equal(mismatch.result.reason,'readback_mismatch');
 assert.equal(mismatch.result.writeState,'committed');
 assert.equal(mismatch.result.writes,true);
 assert.equal(mismatch.result.retry,false);
 assert.equal(mismatch.result.readback.schemaVersion,6);
 assert.equal(sql(lied.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,6);
 assertQuiet(mismatch.result);
}

{
 const raced=await install({schema:6,race:true});
 raced.putObject('metadata.json',metadataBody());
 const outcome=await execute(['--target','iptv','--load','--confirm','load'],raced);
 assert.equal(outcome.exit,3,JSON.stringify(outcome.result));
 assert.equal(outcome.result.reason,'source_changed');
 assert.equal(outcome.result.writeState,'none');
 assert.equal(outcome.result.writes,false);
 assert.equal(productionBatches(raced.calls).length,0);
 assert.equal(sql(raced.productionFile,'SELECT COUNT(*) AS n FROM metadata_cache;',{json:true})[0].n,0);
 const broken=await install({schema:6,atomicScratch:false});
 broken.putObject('metadata.json',metadataBody());
 const fence=await execute(['--target','iptv','--load','--confirm','load'],broken);
 assert.equal(fence.exit,3,JSON.stringify(fence.result));
 assert.equal(fence.result.reason,'fence_not_atomic');
 assert.equal(fence.result.writeState,'none');
 assert.equal(fence.result.writes,false);
 assert.equal(productionBatches(broken.calls).length,0);
 assert.equal(sql(broken.productionFile,'SELECT COUNT(*) AS n FROM metadata_cache;',{json:true})[0].n,0);
 const invalid=await install({schema:6});
 invalid.putObject('metadata.json','{');
 const bad=await execute(['--target','iptv','--load','--confirm','load'],invalid);
 assert.equal(bad.exit,3,JSON.stringify(bad.result));
 assert.equal(bad.result.reason,'source_invalid');
 assert.equal(productionBatches(invalid.calls).length,0);
}

{
 const installed=await install({schema:5});
 installed.putObject('metadata.json',metadataBody());
 installed.putObject('sync.json',{stage:'epg',updatedAt:new Date(NOW-16*60*1000).toISOString()});
 sql(installed.productionFile,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:heat',1,'Heat','2020-01-01T00:00:00.000Z');");
 const applied=await execute(['--target','iptv','--apply','--confirm','apply'],installed);
 assert.equal(applied.exit,0,JSON.stringify(applied.result));
 const loaded=await execute(['--target','iptv','--load','--confirm','load'],installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.mode,'r2');
 assert.equal(loaded.result.keys,2);
 assert.equal(loaded.result.cacheGeneration,loaded.result.mirrorGeneration);
 assertQuiet(loaded.result);
 const importBatch=productionBatches(installed.calls).find(item=>/INSERT\s+INTO\s+metadata_cache\b/i.test(item.body));
 const parsed=JSON.parse(importBatch.body);
 assert.equal(parsed.batch.length,5);
 assert.equal(parsed.batch.some(item=>item.sql.includes("a;b''c")),true);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM film;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,"SELECT COUNT(*) AS n FROM film WHERE id='film:orphan';",{json:true})[0].n,0);
 const stored=JSON.parse(sql(installed.productionFile,"SELECT payload_json FROM metadata_cache WHERE cache_key='heat';",{json:true})[0].payload_json);
 assert.deepEqual(stored,metadataBody().heat);
 assert.deepEqual(sql(installed.productionFile,'SELECT cache_key FROM metadata_cache ORDER BY cache_key;',{json:true}).map(row=>row.cache_key),['heat','orphan']);
 const beforeActivate=productionBatches(installed.calls).length;
 installed.objects.set('metadata.json',{text:JSON.stringify({heat:{metadataAt:'2021-01-01T00:00:00.000Z'}}),etag:'etag-moved'});
 const missed=await execute(['--target','iptv','--activate','--confirm','activate'],installed);
 assert.equal(missed.exit,3,JSON.stringify(missed.result));
 assert.equal(missed.result.reason,'metadata_cache_fence');
 assert.equal(productionBatches(installed.calls).length,beforeActivate);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM metadata_cache_authority;",{json:true})[0].mode,'r2');
 installed.putObject('metadata.json',metadataBody());
 const moved=await install({schema:6,flipAfterImport:true});
 moved.putObject('metadata.json',metadataBody());
 const imported=await execute(['--target','iptv','--load','--confirm','load'],moved);
 assert.equal(imported.exit,3,JSON.stringify(imported.result));
 assert.equal(imported.result.reason,'mirror_moved');
 assert.equal(imported.result.writes,true);
 assert.equal(imported.result.writeState,'committed');
 assert.equal(imported.result.retry,false);
 assert.equal(imported.result.readback.marker.mode,'r2');
 assert.equal(sql(moved.productionFile,'SELECT COUNT(*) AS n FROM metadata_cache;',{json:true})[0].n,2);
 const fresh=await install({schema:6});
 fresh.putObject('metadata.json',metadataBody());
 sql(fresh.productionFile,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:heat',1,'Heat','2020-01-01T00:00:00.000Z');");
 const ready=await execute(['--target','iptv','--load','--confirm','load'],fresh);
 assert.equal(ready.exit,0,JSON.stringify(ready.result));
 const activated=await execute(['--target','iptv','--activate','--confirm','activate'],fresh);
 assert.equal(activated.exit,0,JSON.stringify(activated.result));
 assert.equal(activated.result.mode,'d1');
 assert.equal(activated.result.cacheGeneration,activated.result.mirrorGeneration);
 assert.equal(activated.result.cacheRows,2);
 assertQuiet(activated.result);
 assert.equal(sql(fresh.productionFile,"SELECT mode FROM metadata_cache_authority;",{json:true})[0].mode,'d1');
 assert.equal(sql(fresh.productionFile,'SELECT COUNT(*) AS n FROM film;',{json:true})[0].n,1);
 assert.equal(sql(fresh.productionFile,"SELECT COUNT(*) AS n FROM metadata_cache WHERE cache_key='orphan';",{json:true})[0].n,1);
 assert.equal(activated.result.writeState,'committed');
 assert.equal(fresh.calls.urls.some(url=>url.includes('time_travel/restore')),false);
 const loadLie=await install({schema:6,afterWrite:'load-empty'});
 loadLie.putObject('metadata.json',metadataBody());
 const loadMismatch=await execute(['--target','iptv','--load','--confirm','load'],loadLie);
 assert.equal(loadMismatch.exit,3,JSON.stringify(loadMismatch.result));
 assert.equal(loadMismatch.result.reason,'metadata_cache_loss');
 assert.equal(loadMismatch.result.writeState,'committed');
 assert.equal(loadMismatch.result.writes,true);
 assert.notEqual(loadMismatch.result.writes,false);
 assert.equal(loadMismatch.result.retry,false);
 assert.equal(sql(loadLie.productionFile,'SELECT COUNT(*) AS n FROM metadata_cache;',{json:true})[0].n,2);
 assert.equal(loadMismatch.result.readback.cacheRows,2);
 const activateLie=await install({schema:6});
 activateLie.putObject('metadata.json',metadataBody());
 const primed=await execute(['--target','iptv','--load','--confirm','load'],activateLie);
 assert.equal(primed.exit,0,JSON.stringify(primed.result));
 activateLie.state.afterWrite='activate-stale';
 const activateMismatch=await execute(['--target','iptv','--activate','--confirm','activate'],activateLie);
 assert.equal(activateMismatch.exit,3,JSON.stringify(activateMismatch.result));
 assert.equal(activateMismatch.result.reason,'metadata_cache_cas');
 assert.equal(activateMismatch.result.writeState,'committed');
 assert.equal(activateMismatch.result.writes,true);
 assert.equal(activateMismatch.result.retry,false);
 assert.equal(sql(activateLie.productionFile,"SELECT mode FROM metadata_cache_authority;",{json:true})[0].mode,'d1');
 assertQuiet(activateMismatch.result);
 const modeSql=productionBatches(fresh.calls).map(item=>item.body).find(body=>body.includes("mode='d1'"));
 assert.equal(typeof modeSql,'string');
}

for(const root of roots)fs.rmSync(root,{recursive:true,force:true});
