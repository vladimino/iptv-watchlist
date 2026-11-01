// The published EPG operator. Counts below are fixtures. Nothing here calls Cloudflare.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {applyDecision, migrationStatements, PREDICTION_TABLES, PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID, publishedEpgStatements, runPublishedEpgProduction} from '../scripts/published-epg-production.mjs';

const TOKEN='test-token-value';
const SECRET='test-secret-value';
const script=path.resolve('scripts/published-epg-production.mjs');
const offline=path.resolve('scripts/published-epg-authority.mjs');
const statements=publishedEpgStatements();
assert.deepEqual(statements,migrationStatements(fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8')));
assert.ok(statements.length>3);
assert.equal(statements.some(sql=>/\bINTO\s+film\b|\bINTO\s+candidate\b|\bINTO\s+prediction_|\bCREATE\s+TABLE\s+prediction_|\bwatchlist_film\b|\bCOMMIT\b/i.test(sql)),false);
assert.equal(statements.some(sql=>/\bBEGIN\b/i.test(sql)&&!/^CREATE TRIGGER\b/i.test(sql.trim())),false);
assert.match(statements.join('\n'),/prediction_domain_authority/);
for(const name of PREDICTION_TABLES)assert.match(statements.join('\n'),new RegExp(name));
const absentTables=Object.fromEntries(['published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'].map(name=>[name,false]));
const readyPrediction=Object.fromEntries(PREDICTION_TABLES.map(name=>[name,true]));
assert.equal(applyDecision({schemaVersion:6,tables:absentTables,prediction:readyPrediction}),'schema_unexpected');
assert.equal(applyDecision({schemaVersion:7,tables:{published_epg_authority:false}}),'prediction_prerequisite');
assert.equal(applyDecision({schemaVersion:7,tables:absentTables,prediction:readyPrediction}),'apply');
assert.equal(applyDecision({schemaVersion:5,tables:{published_epg_authority:false}}),'schema_unexpected');
assert.equal(applyDecision({schemaVersion:8,tables:{published_epg_authority:false}}),'partial_schema');
assert.equal(applyDecision({schemaVersion:6,tables:{published_epg_authority:true}}),'partial_schema');
assert.equal(applyDecision({schemaVersion:8,tables:Object.fromEntries(['published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'].map(name=>[name,true]))}),'already_applied');

const bare=spawnSync(process.execPath,[script],{encoding:'utf8'});
assert.equal(bare.status,0,bare.stderr);
assert.deepEqual(JSON.parse(bare.stdout),{configured:false,writes:false,writeState:'none'});
const revert=spawnSync(process.execPath,[script,'--revert','--target','iptv'],{encoding:'utf8'});
assert.equal(revert.status,2);
assert.match(revert.stderr,/confirm/);
 const missingDrain=spawnSync(process.execPath,[script,'--activate','--confirm','activate','--target','iptv'],{encoding:'utf8'});
assert.equal(missingDrain.status,2);
assert.match(missingDrain.stderr,/producers_not_drained/);
const missingConfirm=spawnSync(process.execPath,[script,'--apply','--target','iptv'],{encoding:'utf8'});
assert.equal(missingConfirm.status,2);
assert.match(missingConfirm.stderr,/confirm/);
const badTarget=spawnSync(process.execPath,[script,'--load','--confirm','load','--target','other'],{encoding:'utf8'});
assert.equal(badTarget.status,2);
assert.match(badTarget.stderr,/target_invalid/);

const NAMES=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'];
function sql(file, input, {json=false}={}){
 const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8',maxBuffer:1<<26});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
 if(!json)return result.stdout;
 const text=result.stdout.trim();
 return text?JSON.parse(text):[];
}
function predict(file){
 sql(file,'UPDATE schema_contract SET version=7 WHERE id=1;\n'+PREDICTION_TABLES.map(name=>'CREATE TABLE '+name+' (id INTEGER);').join('\n'));
}
function applyMigrations(file, count){
 for(const name of NAMES.slice(0,count)){
  const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/'+name+'.sql','utf8'),encoding:'utf8'});
  if(result.status!==0)throw new Error(name+'\n'+result.stderr);
 }
}
function responseJson(payload, status=200){
 return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
}
function baseEnv(overrides={}){
 return {
  D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,
  D1_BACKFILL_API_TOKEN:TOKEN,
  R2_SNAPSHOT_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,
  R2_SNAPSHOT_ACCESS_KEY_ID:'test-access',
  R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,
  R2_SNAPSHOT_BUCKET:'iptv',
  R2_SNAPSHOT_ENDPOINT:'http://127.0.0.1',
  ...overrides,
 };
}
function canonicalEnv(overrides={}){
 const env=baseEnv();
 delete env.R2_SNAPSHOT_ENDPOINT;
 return {...env,...overrides};
}
async function install(schema){
 const root=await mkdtemp(path.join(os.tmpdir(),'air319-'));
 const productionFile=path.join(root,'production.sqlite');
 sql(productionFile,'PRAGMA user_version=0;');
 applyMigrations(productionFile, schema);
 const objects=new Map();
 const calls={urls:[], batches:[]};
 function putObject(key, value){
  const text=typeof value==='string'?value:JSON.stringify(value);
  objects.set(key,{text, etag:'etag-'+key+'-'+text.length});
 }
 function runRead(file, statement){
  const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+statement,encoding:'utf8',maxBuffer:1<<26});
  if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
  const text=result.stdout.trim();
  return responseJson({success:true,result:[{success:true,results:text?JSON.parse(text):[]}]});
 }
 function runBatch(file, batch){
  const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+batch.join('\n')+'\nCOMMIT;\n',encoding:'utf8',maxBuffer:1<<26});
  if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
  return responseJson({success:true,result:batch.map(()=>({success:true,results:[]}))});
 }
 async function fetchImpl(url, init={}){
  const target=new URL(url);
  calls.urls.push(target.pathname);
  assert.equal(target.pathname.includes('time_travel/restore'),false);
  const database=target.pathname.match(/\/d1\/database\/([^/]+)(?:\/(.*))?$/);
  if(database){
   const id=database[1], rest=database[2]||'';
   assert.equal(id,PRODUCTION_DATABASE_ID);
   if((init.method||'GET')==='GET'&&rest==='')return responseJson({success:true,result:{uuid:PRODUCTION_DATABASE_ID,name:'iptv'}});
   if((init.method||'GET')==='GET'&&rest==='time_travel/bookmark')return responseJson({success:true,result:{bookmark:'bookmark-before-image'}});
   if((init.method||'GET')!=='POST'||rest!=='query')return responseJson({success:false},404);
   const body=JSON.parse(init.body);
   if(body.batch){calls.batches.push(body.batch.map(item=>item.sql));return runBatch(productionFile, body.batch.map(item=>item.sql));}
   if(typeof body.sql==='string')return runRead(productionFile, body.sql);
   return responseJson({success:false},400);
  }
  if(!target.pathname.startsWith('/iptv/'))return new Response('no',{status:404});
  const key=decodeURIComponent(target.pathname.slice('/iptv/'.length));
  const object=objects.get(key);
  if((init.method||'GET')==='PUT'){
   const header=new Headers(init.headers||{});
   const match=header.get('if-match');
   if(object&&match&&match.replace(/^"|"$/g,'')!==object.etag)return new Response(null,{status:412});
   if(!object&&header.get('if-none-match')!=='*')return new Response(null,{status:412});
   const text=String(init.body??'');
   const etag='etag-'+key+'-'+Buffer.byteLength(text);
   objects.set(key,{text,etag});
   return new Response(null,{status:200,headers:{etag:'"'+etag+'"','content-length':'0'}});
  }
  if(!object)return new Response(null,{status:404});
  const headers={'etag':'"'+object.etag+'"','content-length':String(Buffer.byteLength(object.text)),'content-type':'application/json'};
  if((init.method||'GET')==='HEAD')return new Response(null,{status:200,headers});
  if((init.method||'GET')==='GET')return new Response(object.text,{status:200,headers});
  return new Response('no',{status:403});
 }
 return {productionFile, putObject, fetchImpl, calls, objects};
}
function argv(args){return ['node','published-epg-production.mjs',...args];}
function run(args, installed, env){
 return runPublishedEpgProduction({argv:argv(args), env:env||baseEnv(), fetchImpl:installed.fetchImpl, now:()=>Date.parse('2026-11-01T12:00:00.000Z')});
}

{
 const installed=await install(6);
 const quiet=baseEnv({R2_SNAPSHOT_ACCOUNT_ID:'',R2_SNAPSHOT_ACCESS_KEY_ID:'',R2_SNAPSHOT_SECRET_ACCESS_KEY:'',R2_SNAPSHOT_BUCKET:''});
 const status=await run(['--target','iptv'], installed, quiet);
 assert.equal(status.exit,0,JSON.stringify(status.result));
 assert.equal(status.result.writes,false);
 assert.equal(status.result.schemaVersion,6);
 assert.equal(status.result.marker,null);
 assert.equal(status.result.r2,'not_configured');
 assert.equal(installed.calls.batches.length,0);
 assert.equal(JSON.stringify(status.result).includes(TOKEN),false);
}

{
 const installed=await install(5);
 const refused=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(refused.exit,3);
 assert.equal(refused.result.reason,'schema_unexpected');
 assert.equal(installed.calls.batches.length,0);
 assert.equal(sql(installed.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,5);
}

{
 const installed=await install(6);
 predict(installed.productionFile);
 const applied=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(applied.exit,0,JSON.stringify(applied.result));
 assert.equal(applied.result.operation,'apply');
 assert.equal(applied.result.mode,'r2');
 assert.equal(applied.result.generation,0);
 assert.equal(applied.result.programmeRunId,null);
 assert.equal(applied.result.schemaVersion,8);
 assert.equal(installed.calls.batches.length,1);
 assert.equal(installed.calls.batches[0].some(sql=>/INTO film|INTO candidate|INTO prediction_|CREATE TABLE prediction_|watchlist_film/i.test(sql)),false);
 const again=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(again.exit,3);
 assert.equal(again.result.reason,'already_applied');
 assert.equal(installed.calls.batches.length,1);
 const programme={runId:'run-a',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat',title:'Heat',shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat'}]};
 installed.putObject('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
 installed.putObject('programme.json',programme);
 installed.putObject('watchlist.json',watchlist);
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.mode,'r2');
 assert.equal(loaded.result.programmeRunId,'run-a');
 const activated=await run(['--activate','--confirm','activate','--producers-drained','--target','iptv'], installed);
 assert.equal(activated.exit,0,JSON.stringify(activated.result));
 assert.equal(activated.result.mode,'d1');
 assert.equal(activated.result.programmeRunId,'run-a');
 const row=sql(installed.productionFile,"SELECT mode, programme_run_id FROM published_epg_authority WHERE id=1;",{json:true})[0];
 assert.equal(row.mode,'d1');
 assert.equal(row.programme_run_id,'run-a');
 installed.putObject('watchlist.json',{updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:stale'}]});
 const reverted=await run(['--revert','--confirm','r2','--target','iptv'], installed, canonicalEnv());
 assert.equal(reverted.exit,0,JSON.stringify(reverted.result));
 assert.equal(reverted.result.mode,'r2');
 assert.equal(JSON.parse(installed.objects.get('watchlist.json').text).films[0].id,'film:heat');
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'r2');
}

{
 const root=await mkdtemp(path.join(os.tmpdir(),'air319-offline-'));
 const database=path.join(root,'local.sqlite');
 sql(database,'PRAGMA user_version=0;');
 applyMigrations(database,6);
 const blocked=spawnSync('sqlite3',['-bail',database],{input:fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'),encoding:'utf8'});
 assert.notEqual(blocked.status,0);
 assert.equal(sql(database,'SELECT version FROM schema_contract;',{json:true})[0].version,6);
 assert.equal(sql(database,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'published_epg%' OR name='schema_contract_no_downgrade';",{json:true})[0].n,0);
 predict(database);
 const migrated=spawnSync('sqlite3',['-bail',database],{input:fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'),encoding:'utf8'});
 assert.equal(migrated.status,0,migrated.stderr);
 const bareOffline=spawnSync(process.execPath,[offline],{encoding:'utf8'});
 assert.equal(bareOffline.status,0,bareOffline.stderr);
 assert.deepEqual(JSON.parse(bareOffline.stdout),{configured:false,writes:false});
 const refused=spawnSync(process.execPath,[offline,'--database',path.join(root,'iptv','local.sqlite')],{encoding:'utf8'});
 assert.equal(refused.status,2);
 assert.match(refused.stderr,/production/);
 const status=spawnSync(process.execPath,[offline,'--database',database],{encoding:'utf8'});
 assert.equal(status.status,0,status.stderr);
 assert.equal(JSON.parse(status.stdout).mode,'r2');
 assert.equal(JSON.parse(status.stdout).writes,false);
 const programme={runId:'run-off',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat',shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat'}]};
 const pointer={programmeRunId:'run-off',phase:'published'};
 const programmeFile=path.join(root,'programme.json'),watchlistFile=path.join(root,'watchlist.json'),pointerFile=path.join(root,'pointer.json');
 fs.writeFileSync(programmeFile,JSON.stringify(programme));
 fs.writeFileSync(watchlistFile,JSON.stringify(watchlist));
 fs.writeFileSync(pointerFile,JSON.stringify(pointer));
 const args=['--database',database,'--programme',programmeFile,'--watchlist',watchlistFile,'--pointer',pointerFile];
 const loaded=spawnSync(process.execPath,[offline,'--load','--confirm','load',...args],{encoding:'utf8'});
 assert.equal(loaded.status,0,loaded.stderr);
 assert.equal(JSON.parse(loaded.stdout).mode,'r2');
 assert.equal(JSON.parse(loaded.stdout).programmeRunId,'run-off');
 const activated=spawnSync(process.execPath,[offline,'--activate','--confirm','activate',...args],{encoding:'utf8'});
 assert.equal(activated.status,0,activated.stderr);
 assert.equal(JSON.parse(activated.stdout).mode,'d1');
 const reverted=spawnSync(process.execPath,[offline,'--revert','--confirm','r2',...args],{encoding:'utf8'});
 assert.equal(reverted.status,0,reverted.stderr);
 assert.equal(JSON.parse(reverted.stdout).mode,'r2');
 assert.equal(sql(database,'SELECT COUNT(*) AS n FROM film;',{json:true})[0].n,0);
}

{
 const installed=await install(6);
 const applied=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(applied.exit,3);
 assert.equal(applied.result.reason,'schema_unexpected');
 assert.equal(installed.calls.batches.length,0);
 assert.equal(sql(installed.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,6);
 assert.equal(sql(installed.productionFile,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'published_epg%';",{json:true})[0].n,0);
 const bareSeven=await install(6);
 sql(bareSeven.productionFile,'UPDATE schema_contract SET version=7 WHERE id=1;');
 const held=await run(['--apply','--confirm','apply','--target','iptv'], bareSeven);
 assert.equal(held.exit,3);
 assert.equal(held.result.reason,'prediction_prerequisite');
 assert.equal(bareSeven.calls.batches.length,0);
 assert.equal(sql(bareSeven.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,7);
 assert.equal(sql(bareSeven.productionFile,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'published_epg%';",{json:true})[0].n,0);
}

{
 const installed=await install(6);
 predict(installed.productionFile);
 assert.equal((await run(['--apply','--confirm','apply','--target','iptv'], installed)).exit,0);
 const programme={runId:'run-a',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat',title:'Heat',shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat'}]};
 installed.putObject('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
 installed.putObject('programme.json',programme);
 installed.putObject('watchlist.json',watchlist);
 assert.equal((await run(['--load','--confirm','load','--target','iptv'], installed)).exit,0);
 let watchlistReads=0;
 const original=installed.fetchImpl;
 installed.fetchImpl=async(url,init)=>{
  const response=await original(url,init);
  if(String(url).includes('/watchlist.json')){watchlistReads++;if(watchlistReads===3)installed.putObject('watchlist.json',{updatedAt:'2026-11-01T13:00:00.000Z',films:[{id:'film:stale'}]});}
  return response;
 };
 const activated=await run(['--activate','--confirm','activate','--producers-drained','--target','iptv'], installed);
 assert.notEqual(activated.exit,0,JSON.stringify(activated.result));
 assert.equal(activated.result.reason,'published_epg_fence');
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'r2');
}

{
 const installed=await install(6);
 predict(installed.productionFile);
 assert.equal((await run(['--apply','--confirm','apply','--target','iptv'], installed)).exit,0);
 const programme={runId:'run-a',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat',title:'Heat',shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat'}]};
 installed.putObject('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
 installed.putObject('programme.json',programme);
 installed.putObject('watchlist.json',watchlist);
 assert.equal((await run(['--load','--confirm','load','--target','iptv'], installed)).exit,0);
 assert.equal((await run(['--activate','--confirm','activate','--producers-drained','--target','iptv'], installed)).exit,0);
 installed.putObject('watchlist.json',{updatedAt:'2026-11-01T13:00:00.000Z',films:[{id:'film:stale'}]});
 let puts=0;
 const original=installed.fetchImpl;
 installed.fetchImpl=async(url,init)=>{
  if((init?.method||'GET')==='PUT'){puts++;if(puts===2)return new Response('no',{status:500});}
  return original(url,init);
 };
 const reverted=await run(['--revert','--confirm','r2','--target','iptv'], installed, canonicalEnv());
 assert.notEqual(reverted.exit,0,JSON.stringify(reverted.result));
 assert.equal(reverted.result.writeState,'partial');
 assert.equal(reverted.result.writes,true);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'d1');
}

{
 const installed=await install(6);
 const chain=spawnSync('sqlite3',['-bail',installed.productionFile],{input:'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'),encoding:'utf8'});
 assert.equal(chain.status,0,chain.stderr);
 assert.equal(sql(installed.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,7);
 const applied=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(applied.exit,0,JSON.stringify(applied.result));
 assert.equal(applied.result.schemaVersion,8);
 assert.equal(applied.result.mode,'r2');
 assert.equal(sql(installed.productionFile,"SELECT mode FROM prediction_domain_authority WHERE id=1;",{json:true})[0].mode,'r2');
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'r2');
 const programme={runId:'run-a',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat',title:'Heat',shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat'}]};
 installed.putObject('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
 installed.putObject('programme.json',programme);
 installed.putObject('watchlist.json',watchlist);
 assert.equal((await run(['--load','--confirm','load','--target','iptv'], installed)).exit,0);
 const urls=installed.calls.urls.length;
 const batches=installed.calls.batches.length;
 const held=await run(['--activate','--confirm','activate','--target','iptv'], installed);
 assert.equal(held.exit,2);
 assert.equal(held.result.reason,'producers_not_drained');
 assert.equal(held.result.writes,false);
 assert.equal(installed.calls.urls.length,urls);
 assert.equal(installed.calls.batches.length,batches);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'r2');
 const original=installed.fetchImpl;
 let puts=0;
 installed.fetchImpl=async(url,init)=>{
  if((init?.method||'GET')==='PUT')puts++;
  const body=String(init?.body||'');
  if((init?.method||'GET')==='POST'&&body.includes("mode='d1'"))installed.putObject('watchlist.json',{updatedAt:'2026-11-01T13:00:00.000Z',films:[{id:'film:raced'}]});
  return original(url,init);
 };
 const raced=await run(['--activate','--confirm','activate','--producers-drained','--target','iptv'], installed);
 assert.notEqual(raced.exit,0,JSON.stringify(raced.result));
 assert.equal(raced.result.reason,'cutover_race');
 assert.equal(puts,0);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'r2');
 assert.equal(JSON.parse(installed.objects.get('watchlist.json').text).films[0].id,'film:raced');
}

{
 const installed=await install(6);
 const chain=spawnSync('sqlite3',['-bail',installed.productionFile],{input:'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'),encoding:'utf8'});
 assert.equal(chain.status,0,chain.stderr);
 assert.equal((await run(['--apply','--confirm','apply','--target','iptv'], installed)).exit,0);
 const programme={runId:'run-a',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat',title:'Heat',shows:[]}]};
 const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:heat'}]};
 installed.putObject('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
 installed.putObject('programme.json',programme);
 installed.putObject('watchlist.json',watchlist);
 assert.equal((await run(['--load','--confirm','load','--target','iptv'], installed)).exit,0);
 assert.equal((await run(['--activate','--confirm','activate','--producers-drained','--target','iptv'], installed)).exit,0);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'d1');
 for(const endpoint of ['https://evil.example','http://127.0.0.1']){
  const urls=installed.calls.urls.length;
  const batches=installed.calls.batches.length;
  const refused=await run(['--revert','--confirm','r2','--target','iptv'], installed, canonicalEnv({R2_SNAPSHOT_ENDPOINT:endpoint}));
  assert.equal(refused.exit,3,endpoint+' '+JSON.stringify(refused.result));
  assert.equal(refused.result.reason,'endpoint_refused');
  assert.equal(refused.result.writes,false);
  assert.equal(installed.calls.urls.length,urls);
  assert.equal(installed.calls.batches.length,batches);
  assert.equal(sql(installed.productionFile,"SELECT mode FROM published_epg_authority WHERE id=1;",{json:true})[0].mode,'d1');
 }
}

console.log('published EPG operator: apply leaves r2, load and activate are separate, revert repairs the watchlist');
