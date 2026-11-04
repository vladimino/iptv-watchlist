// The discovery schema operator. Counts below are fixtures. Nothing here calls Cloudflare.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {createD1Adapter} from '../scripts/d1-backfill.mjs';
import {evidenceKey} from '../src/discovery-authority.js';
import {applyDecision, DISCOVERY_TABLES, discoveryStatements, LEDGER_MAX_BYTES, ledgerStatements, loadDecision, migrationStatements, packLedgerBatches, PREREQUISITE, PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID, runDiscoveryProduction} from '../scripts/discovery-production.mjs';

const TOKEN='test-token-value';
const SECRET='test-secret-value';
const script=path.resolve('scripts/discovery-production.mjs');
const statements=discoveryStatements();
assert.equal(statements.length,29);
assert.deepEqual(statements,migrationStatements(fs.readFileSync('migrations/0011_discovery_authority.sql','utf8')));
assert.equal(statements.some(sql=>/\bINTO\s+film\b|\bINTO\s+candidate\b|\bINTO\s+ratings_|\bINTO\s+prediction_|\bINTO\s+owner_review_|\bINTO\s+published_epg_|\bwatchlist_film\b|\bCOMMIT\b/i.test(sql)),false);
assert.equal(PREREQUISITE.length,26);
assert.equal(DISCOVERY_TABLES.length,16);
for(const name of PREREQUISITE)assert.match(statements[0],new RegExp(name));
const absent=Object.fromEntries(DISCOVERY_TABLES.map(name=>[name,false]));
assert.equal(applyDecision({schemaVersion:10,discovery:absent,prerequisite:true,authorities:true}),'apply');
assert.equal(applyDecision({schemaVersion:9,discovery:absent,prerequisite:true,authorities:true}),'schema_unexpected');
assert.equal(applyDecision({schemaVersion:11,discovery:absent,prerequisite:true,authorities:true}),'schema_unexpected');
assert.equal(applyDecision({schemaVersion:10,discovery:absent,prerequisite:false,authorities:true}),'prerequisite_incomplete');
assert.equal(applyDecision({schemaVersion:10,discovery:absent,prerequisite:true,authorities:false}),'prerequisite_incomplete');
assert.equal(applyDecision({schemaVersion:10,discovery:{...absent,discovery_authority:true},prerequisite:true,authorities:true}),'partial_schema');
assert.equal(applyDecision({schemaVersion:11,discovery:Object.fromEntries(DISCOVERY_TABLES.map(name=>[name,true])),prerequisite:true,authorities:true,marker:{mode:'r2',cutover:'open',generation:0,programmeRunId:null}}),'already_applied');
assert.equal(applyDecision({schemaVersion:11,discovery:Object.fromEntries(DISCOVERY_TABLES.map(name=>[name,true])),prerequisite:true,authorities:true,marker:{mode:'d1',cutover:'open',generation:0,programmeRunId:null}}),'partial_schema');
assert.equal(applyDecision({schemaVersion:11,discovery:Object.fromEntries(DISCOVERY_TABLES.map(name=>[name,true])),prerequisite:true,authorities:true,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old'}}),'loaded');
const tables=Object.fromEntries(DISCOVERY_TABLES.map(name=>[name,true]));
const fresh={schemaVersion:11,discovery:tables,marker:{mode:'r2',cutover:'open',generation:0,programmeRunId:null,publishedProgrammeRunId:null},transfer:{state:'idle',programmeRunId:null},observations:0};
assert.equal(loadDecision(fresh),'load');
assert.equal(loadDecision({...fresh,schemaVersion:10}),'schema_unexpected');
assert.equal(loadDecision({...fresh,marker:{mode:'d1',cutover:'open',generation:0,programmeRunId:null,publishedProgrammeRunId:null}}),'marker_refused');
assert.equal(loadDecision({...fresh,transfer:{state:'loading',programmeRunId:null}}),'partial_load');
assert.equal(loadDecision({...fresh,observations:1}),'partial_load');
assert.equal(loadDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'committed',programmeRunId:'run-old'},observations:2}),'already_loaded');
assert.equal(loadDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'committed',programmeRunId:'run-old'},observations:0}),'already_loaded');
const packed=packLedgerBatches(Array.from({length:51},()=>'SELECT 1'),'run-old');
assert.equal(packed.length,3);
assert.equal(packed.every(batch=>batch.length<=50&&batch.every(sql=>Buffer.byteLength(sql,'utf8')<=100*1024)),true);
assert.match(packed[0][0],/state='loading'/);
assert.match(packed.at(-1).join('\n'),/generation=generation\+1/);
assert.match(packed.at(-1).join('\n'),/state='committed'/);
assert.equal(packed.some(batch=>batch.some(sql=>/mode='d1'|\bdiscovery_decision\b|\bdiscovery_lease\b|\bINTO\s+film\b/i.test(sql))),false);
assert.equal(packLedgerBatches([],'run-old').length,1);
assert.throws(()=>ledgerStatements({programmeRunId:'run-old',items:[{key:'a',title:'x'.repeat(110000)}]}),error=>error.reason==='batch_too_large');
assert.throws(()=>ledgerStatements({programmeRunId:'run-old',items:[{key:'a',shows:Array.from({length:97},()=>({start:1}))}]}),error=>error.reason==='ledger_refused');
assert.throws(()=>ledgerStatements({programmeRunId:'run-old',items:[{key:'a'},{key:'a'}]}),error=>error.reason==='ledger_refused');

const bare=spawnSync(process.execPath,[script],{encoding:'utf8'});
assert.equal(bare.status,0,bare.stderr);
assert.deepEqual(JSON.parse(bare.stdout),{configured:false,writes:false,writeState:'none'});
for(const flag of ['--activate','--import','--revert']){
 const refused=spawnSync(process.execPath,[script,flag,'--confirm','apply','--target','iptv'],{encoding:'utf8'});
 assert.equal(refused.status,2,flag+' '+refused.stdout);
 assert.match(refused.stdout,/usage/);
}
const missingLoad=spawnSync(process.execPath,[script,'--load','--target','iptv'],{encoding:'utf8'});
assert.equal(missingLoad.status,2);
assert.match(missingLoad.stdout,/confirm_required/);
const wrongLoad=spawnSync(process.execPath,[script,'--load','--confirm','apply','--target','iptv'],{encoding:'utf8'});
assert.equal(wrongLoad.status,2);
assert.match(wrongLoad.stdout,/confirm_required/);
const missingConfirm=spawnSync(process.execPath,[script,'--apply','--target','iptv'],{encoding:'utf8'});
assert.equal(missingConfirm.status,2);
assert.match(missingConfirm.stdout,/confirm_required/);
const badTarget=spawnSync(process.execPath,[script,'--apply','--confirm','apply','--target','other'],{encoding:'utf8'});
assert.equal(badTarget.status,2);
assert.match(badTarget.stdout,/target_refused/);
const offline=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database','/tmp/iptv/discovery.sqlite','--apply'],{encoding:'utf8'});
assert.equal(offline.status,2);

const NAMES=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority'];
function sql(file, input, {json=false}={}){
 const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8',maxBuffer:1<<26});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
 if(!json)return result.stdout;
 const text=result.stdout.trim();
 return text?JSON.parse(text):[];
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
function env(){
 return {
  D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,
  D1_BACKFILL_API_TOKEN:TOKEN,
  D1_BACKFILL_DATABASE_ID:PRODUCTION_DATABASE_ID,
  R2_SNAPSHOT_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,
  R2_SNAPSHOT_ACCESS_KEY_ID:'test-access',
  R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,
  R2_SNAPSHOT_BUCKET:'iptv',
 };
}
async function install(count){
 const root=await mkdtemp(path.join(os.tmpdir(),'air320-'));
 const productionFile=path.join(root,'production.sqlite');
 sql(productionFile,'PRAGMA user_version=0;');
 applyMigrations(productionFile, count);
 const objects=new Map();
 const calls={batches:[],gets:[]};
 const control={failAt:null,flipOnGet:null};
 function putObject(key, value, options={}){
  const text=typeof value==='string'?value:JSON.stringify(value);
  objects.set(key,{text, etag:options.etag??('etag-'+key+'-'+text.length), size:options.size??Buffer.byteLength(text)});
 }
 function runRead(statement){
  const result=spawnSync('sqlite3',['-json','-bail',productionFile],{input:'PRAGMA foreign_keys=ON;\n'+statement,encoding:'utf8',maxBuffer:1<<26});
  if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
  const text=result.stdout.trim();
  return responseJson({success:true,result:[{success:true,results:text?JSON.parse(text):[],meta:{rows_read:1,rows_written:0,bookmark:'sql-bookmark-value'}}]});
 }
 function runBatch(batch){
  const result=spawnSync('sqlite3',['-bail',productionFile],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+batch.join('\n')+'\nCOMMIT;\n',encoding:'utf8',maxBuffer:1<<26});
  if(result.status!==0)return responseJson({success:true,result:[{success:false,error:result.stderr.trim()||'statement failed'}]});
  return responseJson({success:true,result:batch.map(()=>({success:true,results:[],meta:{rows_written:1}}))});
 }
 async function fetchImpl(url, init={}){
  const target=new URL(url);
  assert.equal(target.pathname.includes('time_travel/restore'),false);
  const database=target.pathname.match(/\/d1\/database\/([^/]+)(?:\/(.*))?$/);
  if(database){
   const id=database[1], rest=database[2]||'';
   assert.equal(id,PRODUCTION_DATABASE_ID);
   if((init.method||'GET')==='GET'&&rest==='')return responseJson({success:true,result:{uuid:PRODUCTION_DATABASE_ID,name:'iptv'}});
   if((init.method||'GET')==='GET'&&rest==='time_travel/bookmark')return responseJson({success:true,result:{bookmark:'bookmark-before-image'}});
   if((init.method||'GET')!=='POST'||rest!=='query')return responseJson({success:false},404);
   const body=JSON.parse(init.body);
   if(body.batch){
    calls.batches.push(body.batch.map(item=>item.sql));
    if(control.failAt===calls.batches.length)return responseJson({success:false},500);
    return runBatch(body.batch.map(item=>item.sql));
   }
   if(typeof body.sql==='string')return runRead(body.sql);
   return responseJson({success:false},400);
  }
  if(!target.pathname.startsWith('/iptv/'))return new Response('no',{status:404});
  const key=decodeURIComponent(target.pathname.slice('/iptv/'.length));
  const object=objects.get(key);
  if(!object)return new Response(null,{status:404});
  const headers={'etag':'"'+object.etag+'"','content-length':String(object.size),'content-type':'application/json'};
  if((init.method||'GET')==='HEAD')return new Response(null,{status:200,headers});
  if((init.method||'GET')==='GET'){
   calls.gets.push(key);
   if(control.flipOnGet===key)object.etag='flipped-etag-value';
   return new Response(object.text,{status:200,headers});
  }
  return new Response('no',{status:403});
 }
 return {productionFile, putObject, fetchImpl, calls, objects, control};
}
function argv(args){return ['node','discovery-production.mjs',...args];}
function run(args, installed, clock=Date.parse('2026-11-04T12:00:00.000Z')){
 return runDiscoveryProduction({argv:argv(args), env:env(), fetchImpl:installed.fetchImpl, now:()=>clock});
}
function seed(installed){
 installed.putObject('sync.json',{stage:'complete',updatedAt:'2026-11-04T11:00:00.000Z'});
 installed.putObject('epg/resolver-lease.json',{id:'lease-1',expiresAt:0});
 installed.putObject('epg/discovery-latest.json',{programmeRunId:'run-old',items:[{key:'hidden'}]});
 installed.putObject('epg/generations/run-old/discovery-latest.json',{programmeRunId:'run-old',items:[{key:'hidden'}]});
 sql(installed.productionFile,"UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='run-old', generation=2, watchlist_generation=2 WHERE id=1;");
}

{
 const installed=await install(9);
 seed(installed);
 const refused=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'schema_unexpected');
 assert.equal(installed.calls.batches.length,0);
 assert.equal(sql(installed.productionFile,'SELECT version FROM schema_contract;',{json:true})[0].version,9);
}

{
 const installed=await install(10);
 sql(installed.productionFile,'CREATE TABLE discovery_cas (id INTEGER);');
 seed(installed);
 sql(installed.productionFile,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=12 WHERE id=1;");
 const refused=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_schema');
 assert.equal(installed.calls.batches.length,0);
}

{
 const installed=await install(10);
 seed(installed);
 sql(installed.productionFile,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=12 WHERE id=1;");
 installed.putObject('sync.json',{stage:'epg',updatedAt:'2026-11-04T11:50:00.000Z'});
 const refused=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'writer_active');
 assert.equal(installed.calls.batches.length,0);
 const status=await run(['--target','iptv'], installed);
 assert.equal(status.exit,0,JSON.stringify(status.result));
 assert.equal(status.result.writers.sync,'active');
 assert.equal(status.result.writes,false);
}

{
 const installed=await install(10);
 seed(installed);
 sql(installed.productionFile,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=12 WHERE id=1;");
 const status=await run(['--target','iptv'], installed);
 assert.equal(status.exit,0,JSON.stringify(status.result));
 assert.equal(status.result.writes,false);
 assert.equal(status.result.writeState,'none');
 assert.equal(status.result.schemaVersion,10);
 assert.equal(status.result.decision,'apply');
 assert.equal(status.result.discoveryTables,0);
 assert.equal(status.result.prerequisiteTables,26);
 assert.equal(status.result.authorityRows,4);
 assert.equal(status.result.rowsWritten,0);
 assert.equal(status.result.bookmarkPrefix,'bookmark-bef');
 assert.equal(JSON.stringify(status.result).includes('bookmark-before-image'),false);
 assert.equal(JSON.stringify(status.result).includes(TOKEN),false);
 assert.equal(JSON.stringify(status.result).includes(PRODUCTION_DATABASE_ID),false);
 assert.equal(status.result.markers.ratings.generation,12);
 assert.equal(status.result.markers.publishedEpg.programmeRunId,'run-old');
 assert.equal(status.result.source.shared.present,true);
 assert.equal(status.result.source.generation.present,true);
 assert.equal(status.result.source.shared.etagPrefix.length,12);
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 assert.equal(installed.calls.gets.includes('epg/generations/run-old/discovery-latest.json'),false);
 assert.equal(installed.calls.batches.length,0);
 const applied=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(applied.exit,0,JSON.stringify(applied.result));
 assert.equal(applied.result.operation,'apply');
 assert.equal(applied.result.writes,true);
 assert.equal(applied.result.mode,'r2');
 assert.equal(applied.result.generation,0);
 assert.equal(applied.result.observations,0);
 assert.equal(applied.result.schemaVersion,11);
 assert.equal(installed.calls.batches.length,1);
 assert.equal(installed.calls.batches[0].length,29);
 assert.equal(sql(installed.productionFile,"SELECT mode, cutover, generation FROM discovery_authority WHERE id=1;",{json:true})[0].mode,'r2');
 assert.equal(sql(installed.productionFile,"SELECT mode, generation FROM ratings_domain_authority WHERE id=1;",{json:true})[0].generation,12);
 const again=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(again.exit,3,JSON.stringify(again.result));
 assert.equal(again.result.reason,'already_applied');
 assert.equal(again.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
}

function placeLedger(installed, document, options={}){
 const text=JSON.stringify(document);
 const etag=options.etag??'ledger-etag-same-value';
 installed.putObject('epg/discovery-latest.json', text, {etag, size:options.size});
 const generationKey='epg/generations/run-old/discovery-latest.json';
 if(options.generation===false)installed.objects.delete(generationKey);
 else installed.putObject(generationKey, options.generationBody??text, {etag:options.generationEtag??etag, size:options.generationSize??options.size});
}
async function appliedInstall(){
 const installed=await install(10);
 seed(installed);
 sql(installed.productionFile,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=12 WHERE id=1;");
 const applied=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(applied.exit,0,JSON.stringify(applied.result));
 return installed;
}
const sample={key:'obs-1',title:"O'Brien",normalizedTitle:'фильм',year:1999,durations:[100],shows:[{channelId:'news',channel:"O'Brien",start:5,end:9}],seenInLatestSnapshot:true,lastAiring:5,lastSeenAt:'2026-11-04T00:00:00.000Z'};

{
 const installed=await install(10);
 seed(installed);
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'schema_unexpected');
 assert.equal(refused.result.writes,false);
 assert.equal(installed.calls.batches.length,0);
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
}

{
 const installed=await appliedInstall();
 installed.putObject('sync.json',{stage:'epg',updatedAt:'2026-11-04T11:50:00.000Z'});
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'writer_active');
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]},{generationEtag:'other-etag-value'});
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'source_mismatch');
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]},{size:LEDGER_MAX_BYTES+1});
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'ledger_too_large');
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]},{generation:false});
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'source_missing');
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-other',items:[sample]});
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'ledger_refused');
 assert.equal(installed.calls.batches.length,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,0);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 installed.control.flipOnGet='epg/discovery-latest.json';
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'source_changed');
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 sql(installed.productionFile,"UPDATE discovery_transfer SET state='loading' WHERE id=1;");
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_load');
 assert.equal(refused.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.operation,'load');
 assert.equal(loaded.result.writes,true);
 assert.equal(loaded.result.writeState,'committed');
 assert.equal(loaded.result.mode,'r2');
 assert.equal(loaded.result.generation,1);
 assert.equal(loaded.result.observations,1);
 assert.equal(loaded.result.shows,1);
 assert.equal(loaded.result.etagCompared,true);
 assert.equal(loaded.result.etagPrefix.length,12);
 assert.equal(loaded.result.decisions,0);
 assert.equal(loaded.result.admissions,0);
 const text=JSON.stringify(loaded.result);
 assert.equal(text.includes('ledger-etag-same-value'),false);
 assert.equal(text.includes(TOKEN),false);
 assert.equal(text.includes(PRODUCTION_DATABASE_ID),false);
 const marker=sql(installed.productionFile,'SELECT mode, cutover, generation, programme_run_id, published_programme_run_id FROM discovery_authority WHERE id=1;',{json:true})[0];
 assert.equal(marker.mode,'r2');
 assert.equal(marker.cutover,'open');
 assert.equal(marker.generation,1);
 assert.equal(marker.programme_run_id,'run-old');
 assert.equal(marker.published_programme_run_id,'run-old');
 const transfer=sql(installed.productionFile,'SELECT state, programme_run_id FROM discovery_transfer WHERE id=1;',{json:true})[0];
 assert.equal(transfer.state,'committed');
 assert.equal(transfer.programme_run_id,'run-old');
 const row=sql(installed.productionFile,'SELECT evidence_key, payload_json, seen_in_latest, year, last_airing FROM discovery_observation;',{json:true})[0];
 assert.equal(row.evidence_key,evidenceKey(sample));
 assert.equal(row.seen_in_latest,1);
 assert.equal(row.year,1999);
 assert.equal(row.last_airing,5);
 const expected={...sample};
 delete expected.shows;
 assert.deepEqual(JSON.parse(row.payload_json),expected);
 const show=sql(installed.productionFile,'SELECT ordinal, channel, start_ms, end_ms FROM discovery_observation_show;',{json:true})[0];
 assert.equal(show.ordinal,0);
 assert.equal(show.channel,"O'Brien");
 assert.equal(show.start_ms,5);
 assert.equal(show.end_ms,9);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_decision;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,'SELECT lease_id, expires_at FROM discovery_lease WHERE id=1;',{json:true})[0].expires_at,0);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM ratings_domain_authority WHERE id=1;',{json:true})[0].generation,12);
 const loadBatches=installed.calls.batches.slice(1);
 assert.equal(loadBatches.length,loaded.result.batches);
 assert.equal(loadBatches.every(batch=>batch.length<=50),true);
 const written=loadBatches.flat().join('\n');
 assert.equal(/mode='d1'|\bdiscovery_decision\b|\bdiscovery_lease\b|\bINTO\s+film\b/i.test(written),false);
 assert.match(written,/state='loading'/);
 assert.match(written,/state='committed'/);
 const ledgerGets=installed.calls.gets.filter(key=>key==='epg/discovery-latest.json').length;
 const status=await run(['--target','iptv'], installed);
 assert.equal(status.exit,0,JSON.stringify(status.result));
 assert.equal(status.result.writes,false);
 assert.equal(status.result.decision,'loaded');
 assert.equal(status.result.load,'already_loaded');
 assert.equal(status.result.transfer,'committed');
 assert.equal(installed.calls.gets.filter(key=>key==='epg/discovery-latest.json').length,ledgerGets);
 assert.equal(installed.calls.gets.includes('epg/generations/run-old/discovery-latest.json'),false);
 const repeat=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(repeat.exit,3,JSON.stringify(repeat.result));
 assert.equal(repeat.result.reason,'already_loaded');
 assert.equal(repeat.result.writes,false);
 assert.equal(installed.calls.batches.length,1+loaded.result.batches);
 const reapply=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(reapply.exit,3,JSON.stringify(reapply.result));
 assert.equal(reapply.result.reason,'loaded');
 assert.equal(reapply.result.writes,false);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[]});
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.observations,0);
 assert.equal(loaded.result.batches,1);
 assert.equal(sql(installed.productionFile,'SELECT generation, mode FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
 const repeat=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(repeat.result.reason,'already_loaded');
}

{
 const installed=await appliedInstall();
 const items=Array.from({length:51},(_,index)=>({key:'k'+index,title:'T',normalizedTitle:'t',year:2000}));
 placeLedger(installed,{programmeRunId:'run-old',items});
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.observations,51);
 assert.equal(loaded.result.batches,3);
 assert.equal(installed.calls.batches.slice(1).every(batch=>batch.length<=50),true);
 assert.equal(sql(installed.productionFile,'SELECT mode, generation FROM discovery_authority WHERE id=1;',{json:true})[0].mode,'r2');
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,51);
}

{
 const installed=await appliedInstall();
 const items=Array.from({length:51},(_,index)=>({key:'k'+index,title:'T',normalizedTitle:'t'}));
 placeLedger(installed,{programmeRunId:'run-old',items});
 const before=installed.calls.batches.length;
 installed.control.failAt=before+2;
 const failed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(failed.exit,4,JSON.stringify(failed.result));
 assert.equal(failed.result.reason,'write_uncertain');
 assert.equal(failed.result.writeState,'unknown');
 assert.equal(failed.result.writes,null);
 assert.equal(installed.calls.batches.length,before+2);
 assert.equal(sql(installed.productionFile,'SELECT generation, mode FROM discovery_authority WHERE id=1;',{json:true})[0].generation,0);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'loading');
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,0);
 installed.control.failAt=null;
 const retry=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(retry.exit,3,JSON.stringify(retry.result));
 assert.equal(retry.result.reason,'partial_load');
 assert.equal(retry.result.writes,false);
 assert.equal(installed.calls.batches.length,before+2);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 const before=installed.calls.batches.length;
 installed.control.failAt=before+1;
 const failed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(failed.exit,4,JSON.stringify(failed.result));
 assert.equal(failed.result.reason,'write_uncertain');
 assert.equal(installed.calls.batches.length,before+1);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'idle');
}

{
 const adapter=createD1Adapter({target:{accountId:PRODUCTION_ACCOUNT_ID,apiToken:TOKEN,endpoint:'https://api.cloudflare.com/client/v4'},databaseId:PRODUCTION_DATABASE_ID,fetchImpl(){throw new Error('sent');}});
 await assert.rejects(()=>adapter.inspect('UPDATE schema_contract SET version=11'),error=>error.kind==='statement');
}
