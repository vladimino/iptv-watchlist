// The discovery schema operator. Counts below are fixtures. Nothing here calls Cloudflare.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {createD1Adapter} from '../scripts/d1-backfill.mjs';
import {evidenceKey} from '../src/discovery-authority.js';
import {activateDecision, activateSql, catalogEntries, decisionEntries, holdDecision, holdSql, importDecision, importIdentity, packImportBatches, resetImportDecision, resetImportSql, scoreEntries, staleEvidenceCount, valuePrefix} from '../scripts/discovery-cutover.mjs';
import {applyDecision, commitSql, DISCOVERY_TABLES, discoveryStatements, LEDGER_MAX_BYTES, ledgerStatements, loadDecision, loadPrefix, migrationStatements, observationShape, packLoadSlice, parseLoadIdentity, PREREQUISITE, PRODUCTION_ACCOUNT_ID, PRODUCTION_DATABASE_ID, resetDecision, resetSql, runDiscoveryProduction} from '../scripts/discovery-production.mjs';

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
assert.equal(loadDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'committed',programmeRunId:'run-old'},observations:2,checkpoint:{hopId:'imported'}}),'already_loaded');
assert.equal(loadDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'committed',programmeRunId:'run-old'},observations:2,checkpoint:{hopId:'import'}}),'already_loaded');
assert.equal(loadDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'committed',programmeRunId:'run-old'},observations:2,checkpoint:{hopId:'load'}}),'partial_load');
const groups=Array.from({length:51},()=>['SELECT 1']);
const packed=packLoadSlice(groups,'run-old',0);
assert.equal(packed.length,1);
assert.equal(packed[0].length,53);
assert.match(packed[0].at(-1),/batches=51/);
assert.equal(packed[0].every(sql=>Buffer.byteLength(sql,'utf8')<=100*1024),true);
const tail=packLoadSlice(groups,'run-old',40);
assert.equal(tail.length,1);
assert.match(tail[0].join('\n'),/batches=51/);
assert.match(tail[0].join('\n'),/batches=40/);
const split=packLoadSlice([Array.from({length:99},()=>'SELECT 1')],'run-old',0);
assert.equal(split.length,2);
assert.equal(split[0].length,98);
assert.equal(split[0].some(sql=>sql.includes('discovery_transfer')),false);
assert.equal(split[1].length,3);
assert.match(split[1].join('\n'),/batches=1/);
assert.match(split[1].join('\n'),/batches=0/);
const widePacked=packLoadSlice([Array.from({length:179},(_,index)=>'SHOW '+index)],'run-old',0);
assert.equal(widePacked.length,2);
assert.equal(widePacked.flat().filter(sql=>sql.startsWith('SHOW ')).length,179);
assert.equal(widePacked[0].some(sql=>sql.includes('discovery_transfer')),false);
assert.match(widePacked[1].join('\n'),/batches=1/);
assert.throws(()=>packLoadSlice([['x'.repeat(1024*1024+1)]],'run-old',0),error=>error.reason==='batch_too_large');
const loadPayload=JSON.stringify({bytes:3,etag:'etag-value',items:1,programmeRunId:'run-old',sha256:'abc',shows:0});
const loadCheckpoint={hopId:'load',programmeRunId:'run-old',payload:loadPayload};
const resetClaim={programmeRunId:'run-old',payload:loadPayload,shape:'open'};
const resetStatements=resetSql(resetClaim);
assert.match(resetStatements[0],/^INSERT INTO discovery_cas/);
assert.equal(resetStatements[0].includes('DELETE'),false);
assert.equal(resetStatements.findIndex(sql=>sql.startsWith('DELETE FROM discovery_observation_show '))>0,true);
assert.equal(resetStatements.findIndex(sql=>sql.startsWith('DELETE FROM discovery_observation '))>resetStatements.findIndex(sql=>sql.startsWith('DELETE FROM discovery_observation_show ')),true);
assert.match(resetStatements[1],/programme_run_id='run-old'/);
assert.match(resetStatements[0],/generation=0/);
assert.match(resetSql({...resetClaim,shape:'torn'})[0],/generation=1/);
assert.equal(/mode='d1'|\bINTO\s+discovery_lease\b|\bINTO\s+discovery_decision\b|\bINTO\s+film\b|\bUPDATE\s+discovery_lease\b|\bUPDATE\s+discovery_decision\b|\bDELETE\s+FROM\s+discovery_lease\b|\bDELETE\s+FROM\s+discovery_decision\b/i.test(resetStatements.join('\n')),false);
const fenced=commitSql('run-old',3).concat(resetStatements).join('\n');
assert.match(fenced,/generation=1/);
assert.equal(fenced.includes('generation+1'),false);
const shapeA=observationShape({key:'a',title:'A',normalizedTitle:'a',year:1});
const shapeB=observationShape({key:'b',title:'B',normalizedTitle:'b',year:2,shows:[{channelId:'c',channel:'C',start:1,end:2}]});
const rowA={key:'a',payload:shapeA.payload,evidence:shapeA.evidence,shows:[]};
const rowB={key:'b',payload:shapeB.payload,evidence:shapeB.evidence,shows:shapeB.shows};
assert.deepEqual(loadPrefix([shapeA,shapeB].map(row=>({key:row.key})),[]),{cursor:0,showCursor:0,resumeAt:0,mismatch:false});
assert.deepEqual(loadPrefix([{key:'a',title:'A',normalizedTitle:'a',year:1},{key:'b',title:'B',normalizedTitle:'b',year:2,shows:[{channelId:'c',channel:'C',start:1,end:2}]}],[rowA]),{cursor:1,showCursor:0,resumeAt:0,mismatch:false});
assert.equal(loadPrefix([{key:'a',title:'A',normalizedTitle:'a',year:1},{key:'b',title:'B',normalizedTitle:'b',year:2}],[rowB]).mismatch,true);
assert.equal(loadPrefix([{key:'a',title:'A',normalizedTitle:'a',year:1}],[{...rowA,payload:'{}'}]).mismatch,true);
assert.equal(loadPrefix([{key:'b',title:'B',normalizedTitle:'b',year:2,shows:[{channelId:'c',channel:'C',start:1,end:2}]}],[{...rowB,shows:[]}]).resumeAt,1);
const twoShows=[{channelId:'c',channel:'C',start:1,end:2},{channelId:'d',channel:'D',start:3,end:4}];
const twoSource={key:'b',title:'B',normalizedTitle:'b',year:2,shows:twoShows};
const twoShape=observationShape(twoSource);
const partialPrefix=loadPrefix([twoSource],[{key:'b',payload:twoShape.payload,evidence:twoShape.evidence,shows:[twoShape.shows[0]]}]);
assert.deepEqual({cursor:partialPrefix.cursor,showCursor:partialPrefix.showCursor,resumeAt:partialPrefix.resumeAt,mismatch:partialPrefix.mismatch},{cursor:0,showCursor:1,resumeAt:2,mismatch:false});
assert.equal(loadPrefix([twoSource],[{key:'b',payload:twoShape.payload,evidence:twoShape.evidence,shows:[twoShape.shows[1]]}]).mismatch,true);
assert.equal(parseLoadIdentity('{"bytes":1,"etag":"e","items":1,"programmeRunId":"run","sha256":"s","shows":0}').etag,'e');
assert.equal(parseLoadIdentity('nope'),null);
assert.equal(parseLoadIdentity('x'.repeat(2001)),null);
assert.equal(loadDecision({...fresh,checkpoint:{hopId:'load'}}),'partial_load');
assert.equal(resetDecision(fresh),'already_reset');
assert.equal(resetDecision({...fresh,transfer:{state:'committed',programmeRunId:'run-old'},marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'}}),'already_loaded');
assert.equal(resetDecision({...fresh,transfer:{state:'loading',programmeRunId:'run-old'},checkpoint:loadCheckpoint}),'reset');
assert.equal(resetDecision({...fresh,transfer:{state:'loading',programmeRunId:'run-old'},checkpoint:{hopId:'load'}}),'partial_mismatch');
assert.equal(resetDecision({...fresh,transfer:{state:'loading',programmeRunId:null}}),'partial_mismatch');
assert.equal(resetDecision({...fresh,observations:2}),'partial_mismatch');
assert.equal(resetDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'loading',programmeRunId:'run-old'},checkpoint:loadCheckpoint}),'reset_torn');
assert.equal(resetDecision({...fresh,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'loading',programmeRunId:'run-old'}}),'partial_mismatch');
assert.equal(resetDecision({...fresh,marker:{mode:'d1',cutover:'open',generation:0,programmeRunId:null,publishedProgrammeRunId:null}}),'marker_refused');
assert.equal(resetDecision({...fresh,sideRows:1,transfer:{state:'loading'}}),'partial_mismatch');
assert.equal(resetDecision({...fresh,foreignObservations:1,transfer:{state:'loading'}}),'partial_mismatch');
assert.equal(resetDecision({...fresh,foreignShows:1,transfer:{state:'loading'}}),'partial_mismatch');
assert.equal(resetDecision({...fresh,checkpoint:{hopId:'seal'},transfer:{state:'loading'}}),'partial_mismatch');
assert.throws(()=>ledgerStatements({programmeRunId:'run-old',items:[{key:'a',title:'x'.repeat(110000)}]}),error=>error.reason==='batch_too_large');
assert.throws(()=>ledgerStatements({programmeRunId:'run-old',items:[{key:'a'},{key:'a'}]}),error=>error.reason==='ledger_refused');
assert.throws(()=>ledgerStatements({programmeRunId:'run-old',items:[{key:'keep',lastAiring:1.5},{key:'fat',shows:Array.from({length:97},()=>({start:1}))}]}),error=>error.reason==='ledger_refused');
for(const size of [97,101,178]){
 const built=ledgerStatements({programmeRunId:'run-old',items:[{key:'wide',shows:Array.from({length:size},(_,index)=>({start:index}))}]});
 assert.equal(built.items,1);
 assert.equal(built.shows,size);
 assert.equal(built.statements.length,size+1);
 assert.equal(built.source.length,1);
}
const mixedLedger=ledgerStatements({programmeRunId:'run-old',items:[{key:'keep',title:'Keep'},{key:'fat',shows:Array.from({length:97},()=>({start:1}))},{key:'next',title:'Next',shows:[{channelId:'c',channel:'C',start:2,end:3}]}]});
assert.equal(mixedLedger.items,3);
assert.equal(mixedLedger.shows,98);
assert.equal(mixedLedger.statements.filter(sql=>sql.includes("'fat'")).length,98);

const bare=spawnSync(process.execPath,[script],{encoding:'utf8'});
assert.equal(bare.status,0,bare.stderr);
assert.deepEqual(JSON.parse(bare.stdout),{configured:false,writes:false,writeState:'none'});
{
 const refused=spawnSync(process.execPath,[script,'--revert','--confirm','apply','--target','iptv'],{encoding:'utf8'});
 assert.equal(refused.status,2,refused.stdout);
 assert.match(refused.stdout,/usage/);
}
for(const [flag,confirm] of [['--import','import'],['--reset-import','reset-import'],['--hold','hold'],['--activate','activate']]){
 const missing=spawnSync(process.execPath,[script,flag,'--target','iptv'],{encoding:'utf8'});
 assert.equal(missing.status,2,flag+' '+missing.stdout);
 assert.match(missing.stdout,/confirm_required/);
 const wrong=spawnSync(process.execPath,[script,flag,'--confirm','apply','--target','iptv'],{encoding:'utf8'});
 assert.equal(wrong.status,2,flag);
 assert.match(wrong.stdout,/confirm_required/);
}
const undrained=spawnSync(process.execPath,[script,'--hold','--confirm','hold','--target','iptv'],{encoding:'utf8'});
assert.equal(undrained.status,2);
assert.match(undrained.stdout,/drain_required/);
const undrainedImport=spawnSync(process.execPath,[script,'--import','--confirm','import','--target','iptv'],{encoding:'utf8'});
assert.equal(undrainedImport.status,2);
assert.match(undrainedImport.stdout,/drain_required/);
const offlineHold=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database','/tmp/iptv/discovery.sqlite','--hold'],{encoding:'utf8'});
assert.equal(offlineHold.status,2);
const offlineResetImport=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database','/tmp/iptv/discovery.sqlite','--reset-import'],{encoding:'utf8'});
assert.equal(offlineResetImport.status,2);
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
const offlineReset=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database','/tmp/iptv/discovery.sqlite','--reset-load'],{encoding:'utf8'});
assert.equal(offlineReset.status,2);
const missingReset=spawnSync(process.execPath,[script,'--reset-load','--target','iptv'],{encoding:'utf8'});
assert.equal(missingReset.status,2);
assert.match(missingReset.stdout,/confirm_required/);
const wrongReset=spawnSync(process.execPath,[script,'--reset-load','--confirm','load','--target','iptv'],{encoding:'utf8'});
assert.equal(wrongReset.status,2);
assert.match(wrongReset.stdout,/confirm_required/);

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
    if(control.beforeBatch)control.beforeBatch(calls.batches.at(-1));
    if(control.failAt===calls.batches.length)return responseJson({success:false},500);
    const response=runBatch(body.batch.map(item=>item.sql));
    if(control.afterBatch)control.afterBatch(calls.batches.length);
    return response;
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
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(refused.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 const cleared=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(cleared.exit,3,JSON.stringify(cleared.result));
 assert.equal(cleared.result.reason,'partial_mismatch');
 assert.equal(cleared.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'loading');
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
 assert.equal(Object.hasOwn(loaded.result,'omitted'),false);
 assert.equal(loaded.result.etagCompared,true);
 assert.equal(loaded.result.etagPrefix.length,12);
 assert.equal(loaded.result.shaPrefix.length,12);
 assert.equal(loaded.result.resumed,false);
 assert.equal(loaded.result.cursorStart,0);
 assert.equal(loaded.result.decisions,0);
 assert.equal(loaded.result.admissions,0);
 const text=JSON.stringify(loaded.result);
 const digest=createHash('sha256').update(installed.objects.get('epg/discovery-latest.json').text).digest('hex');
 assert.equal(loaded.result.shaPrefix,digest.slice(0,12));
 assert.equal(text.includes(digest),false);
 assert.equal(text.includes('ledger-etag-same-value'),false);
 assert.equal(text.includes(TOKEN),false);
 assert.equal(text.includes(PRODUCTION_DATABASE_ID),false);
 const checkpoint=sql(installed.productionFile,'SELECT hop_id, payload_json FROM discovery_checkpoint WHERE id=1;',{json:true})[0];
 assert.equal(checkpoint.hop_id,null);
 assert.equal(checkpoint.payload_json,null);
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
 assert.equal(loadBatches.every(batch=>batch.length<=100),true);
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
 assert.equal(status.result.loadHop,null);
 assert.equal(status.result.transfer,'committed');
 assert.equal(JSON.stringify(status.result).includes('ledger-etag-same-value'),false);
 assert.equal(installed.calls.gets.filter(key=>key==='epg/discovery-latest.json').length,ledgerGets);
 assert.equal(installed.calls.gets.includes('epg/generations/run-old/discovery-latest.json'),false);
 const repeat=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(repeat.exit,3,JSON.stringify(repeat.result));
 assert.equal(repeat.result.reason,'already_loaded');
 assert.equal(repeat.result.writes,false);
 assert.equal(installed.calls.batches.length,1+loaded.result.batches);
 const kept=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(kept.exit,3,JSON.stringify(kept.result));
 assert.equal(kept.result.reason,'already_loaded');
 assert.equal(kept.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 const identity=JSON.stringify({bytes:installed.objects.get('epg/discovery-latest.json').size,etag:installed.objects.get('epg/discovery-latest.json').etag,items:1,programmeRunId:'run-old',sha256:digest,shows:1});
 sql(installed.productionFile,"UPDATE discovery_checkpoint SET hop_id='load', programme_run_id='run-old', generation=0, payload_json='"+identity.replaceAll("'","''")+"' WHERE id=1;");
 const finished=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(finished.exit,0,JSON.stringify(finished.result));
 assert.equal(finished.result.resumed,true);
 assert.equal(finished.result.generation,1);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
 const reapply=await run(['--apply','--confirm','apply','--target','iptv'], installed);
 assert.equal(reapply.exit,3,JSON.stringify(reapply.result));
 assert.equal(reapply.result.reason,'loaded');
 assert.equal(reapply.result.writes,false);
}

{
 const installed=await appliedInstall();
 const fat={key:'fat-show',title:'Slot',shows:Array.from({length:178},(_,index)=>({channelId:'c',channel:'C',start:index,end:index+1}))};
 const second={key:'obs-2',title:'Second',normalizedTitle:'second',year:2001,shows:[{channelId:'n',channel:'N',start:8,end:9}]};
 placeLedger(installed,{programmeRunId:'run-old',items:[fat,second]});
 installed.control.failAt=4;
 const stopped=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(stopped.exit,4,JSON.stringify(stopped.result));
 assert.equal(stopped.result.writeState,'unknown');
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation_show;',{json:true})[0].n,99);
 assert.equal(sql(installed.productionFile,'SELECT batches, state FROM discovery_transfer WHERE id=1;',{json:true})[0].batches,0);
 assert.equal(installed.calls.batches[2].some(sqlText=>sqlText.includes('discovery_transfer')),false);
 installed.control.failAt=null;
 sql(installed.productionFile,"UPDATE discovery_observation_show SET start_ms=999 WHERE observation_key='fat-show' AND ordinal=0;");
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(refused.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation_show;',{json:true})[0].n,99);
 sql(installed.productionFile,"UPDATE discovery_observation_show SET start_ms=0 WHERE observation_key='fat-show' AND ordinal=0;");
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.resumed,true);
 assert.equal(loaded.result.observations,2);
 assert.equal(loaded.result.shows,179);
 assert.equal(loaded.result.mode,'r2');
 assert.equal(loaded.result.generation,1);
 assert.equal(Object.hasOwn(loaded.result,'omitted'),false);
 const keys=sql(installed.productionFile,'SELECT observation_key FROM discovery_observation ORDER BY observation_key;',{json:true}).map(row=>row.observation_key);
 assert.deepEqual(keys,['fat-show','obs-2']);
 assert.equal(sql(installed.productionFile,"SELECT evidence_key FROM discovery_observation WHERE observation_key='fat-show';",{json:true})[0].evidence_key,evidenceKey(fat));
 const span=sql(installed.productionFile,"SELECT COUNT(*) AS n, MIN(ordinal) AS lo, MAX(ordinal) AS hi FROM discovery_observation_show WHERE observation_key='fat-show';",{json:true})[0];
 assert.equal(span.n,178);
 assert.equal(span.lo,0);
 assert.equal(span.hi,177);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation_show;',{json:true})[0].n,179);
 assert.equal(installed.calls.batches.flat().filter(sqlText=>sqlText.startsWith('INSERT INTO discovery_observation ')&&sqlText.includes("'fat-show'")).length,1);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
}

{
 const installed=await appliedInstall();
 const fat={key:'wide-101',title:'Wide',shows:Array.from({length:101},(_,index)=>({channelId:'c',channel:'C',start:index,end:index+1}))};
 placeLedger(installed,{programmeRunId:'run-old',items:[fat]});
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.observations,1);
 assert.equal(loaded.result.shows,101);
 assert.equal(loaded.result.generation,1);
 assert.equal(loaded.result.mode,'r2');
 assert.equal(sql(installed.productionFile,"SELECT evidence_key FROM discovery_observation WHERE observation_key='wide-101';",{json:true})[0].evidence_key,evidenceKey(fat));
 assert.equal(sql(installed.productionFile,"SELECT COUNT(*) AS n FROM discovery_observation_show WHERE observation_key='wide-101';",{json:true})[0].n,101);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[]});
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.observations,0);
 assert.equal(Object.hasOwn(loaded.result,'omitted'),false);
 assert.equal(loaded.result.batches,2);
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
 const loadBatches=installed.calls.batches.slice(1);
 assert.equal(loadBatches.length,3);
 assert.equal(loadBatches.every(batch=>batch.length<=100),true);
 assert.match(loadBatches[0].join('\n'),/state='loading'/);
 assert.equal(loadBatches[0].some(sql=>sql.startsWith('INSERT INTO discovery_observation ')),false);
 assert.equal(loadBatches[1].length,53);
 assert.match(loadBatches[2].join('\n'),/state='committed'/);
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
 assert.equal(retry.exit,0,JSON.stringify(retry.result));
 assert.equal(retry.result.resumed,true);
 assert.equal(retry.result.cursorStart,0);
 assert.equal(retry.result.observations,51);
 assert.equal(sql(installed.productionFile,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='k0';",{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT mode, generation FROM discovery_authority WHERE id=1;',{json:true})[0].mode,'r2');
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'committed');
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
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
 installed.control.failAt=null;
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.resumed,false);
 assert.equal(loaded.result.observations,1);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
}

{
 const installed=await appliedInstall();
 const items=Array.from({length:51},(_,index)=>({key:'k'+index,title:'x'.repeat(20000),normalizedTitle:'t',shows:[{channelId:'c',channel:'C',start:index,end:index+1}]}));
 placeLedger(installed,{programmeRunId:'run-old',items});
 const before=installed.calls.batches.length;
 installed.control.failAt=before+3;
 const failed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(failed.exit,4,JSON.stringify(failed.result));
 assert.equal(failed.result.reason,'write_uncertain');
 const stored=sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n;
 assert.equal(stored>0&&stored<51,true,String(stored));
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,0);
 assert.equal(sql(installed.productionFile,"SELECT state, hop_id FROM discovery_transfer t, discovery_checkpoint c WHERE t.id=1 AND c.id=1;",{json:true})[0].state,'loading');
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'load');
 installed.control.failAt=null;
 const mid=await run(['--target','iptv'], installed);
 assert.equal(mid.result.load,'partial_load');
 assert.equal(mid.result.loadHop,'load');
 assert.equal(mid.result.loadEtagPrefix,'ledger-etag-');
 assert.equal(JSON.stringify(mid.result).includes('ledger-etag-same-value'),false);
 sql(installed.productionFile,'UPDATE discovery_transfer SET batches=1000 WHERE id=1;');
 const ahead=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(ahead.exit,3,JSON.stringify(ahead.result));
 assert.equal(ahead.result.reason,'partial_mismatch');
 assert.equal(ahead.result.writes,false);
 assert.equal(installed.calls.batches.length,before+3);
 sql(installed.productionFile,'UPDATE discovery_transfer SET batches=0 WHERE id=1;');
 const resumed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(resumed.exit,0,JSON.stringify(resumed.result));
 assert.equal(resumed.result.resumed,true);
 assert.equal(resumed.result.observations,51);
 assert.equal(resumed.result.shows,51);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,51);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation_show;',{json:true})[0].n,51);
 assert.equal(sql(installed.productionFile,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='k0';",{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT mode, generation FROM discovery_authority WHERE id=1;',{json:true})[0].mode,'r2');
 assert.equal(sql(installed.productionFile,'SELECT generation FROM ratings_domain_authority WHERE id=1;',{json:true})[0].generation,12);
 const resumeSql=installed.calls.batches.slice(before+3).flat();
 assert.equal(resumeSql.some(sql=>sql.startsWith('INSERT INTO discovery_observation ')&&sql.includes("'k0'")),false);
 assert.equal(resumeSql.some(sql=>/batches=0/.test(sql)),true);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample,{key:'k2',title:'U',normalizedTitle:'u'}]});
 const before=installed.calls.batches.length;
 installed.control.failAt=before+2;
 const failed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(failed.exit,4,JSON.stringify(failed.result));
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'load');
 installed.control.failAt=null;
 placeLedger(installed,{programmeRunId:'run-old',items:[sample,{key:'k2',title:'U',normalizedTitle:'u'},{key:'k3',title:'V',normalizedTitle:'v'}]},{etag:'ledger-etag-changed'});
 const changed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(changed.exit,3,JSON.stringify(changed.result));
 assert.equal(changed.result.reason,'source_changed');
 assert.equal(changed.result.writes,false);
 assert.equal(installed.calls.batches.length,before+2);
 const cleared=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(cleared.exit,0,JSON.stringify(cleared.result));
 assert.equal(cleared.result.writes,true);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,0);
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(loaded.result.observations,3);
 assert.equal(loaded.result.resumed,false);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM ratings_domain_authority WHERE id=1;',{json:true})[0].generation,12);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 const before=installed.calls.batches.length;
 installed.control.afterBatch=count=>{
  if(count===before+2)sql(installed.productionFile,"UPDATE discovery_observation SET payload_json='{}' WHERE observation_key='obs-1';");
 };
 const failed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(failed.exit,4,JSON.stringify(failed.result));
 assert.equal(failed.result.reason,'readback_mismatch');
 assert.equal(failed.result.writes,null);
 assert.equal(installed.calls.batches.length,before+2);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,0);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'loading');
 installed.control.afterBatch=null;
 const mismatch=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(mismatch.exit,3,JSON.stringify(mismatch.result));
 assert.equal(mismatch.result.reason,'partial_mismatch');
 assert.equal(mismatch.result.writes,false);
 assert.equal(installed.calls.batches.length,before+2);
 const cleared=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(cleared.exit,0,JSON.stringify(cleared.result));
 assert.equal(cleared.result.observations,0);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,'SELECT hop_id, payload_json FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
 assert.equal(sql(installed.productionFile,'SELECT expires_at FROM discovery_lease WHERE id=1;',{json:true})[0].expires_at,0);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM ratings_domain_authority WHERE id=1;',{json:true})[0].generation,12);
 const loaded=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(loaded.exit,0,JSON.stringify(loaded.result));
 assert.equal(JSON.parse(sql(installed.productionFile,'SELECT payload_json FROM discovery_observation;',{json:true})[0].payload_json).title,"O'Brien");
}

async function tornCommit(){
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 const before=installed.calls.batches.length;
 installed.control.failAt=before+3;
 const failed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(failed.exit,4,JSON.stringify(failed.result));
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,0);
 installed.control.failAt=null;
 sql(installed.productionFile,"UPDATE discovery_authority SET generation=1, programme_run_id='run-old', published_programme_run_id='run-old' WHERE id=1;");
 return {installed,before};
}
{
 const {installed}=await tornCommit();
 const resumed=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(resumed.exit,0,JSON.stringify(resumed.result));
 assert.equal(resumed.result.resumed,true);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'committed');
}
{
 const {installed,before}=await tornCommit();
 const ledgerGets=installed.calls.gets.filter(key=>key==='epg/discovery-latest.json').length;
 const cleared=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(cleared.exit,0,JSON.stringify(cleared.result));
 assert.equal(cleared.result.writes,true);
 assert.equal(cleared.result.generation,0);
 assert.equal(sql(installed.productionFile,'SELECT programme_run_id, generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,0);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'idle');
 assert.equal(sql(installed.productionFile,'SELECT generation FROM ratings_domain_authority WHERE id=1;',{json:true})[0].generation,12);
 assert.equal(installed.calls.gets.filter(key=>key==='epg/discovery-latest.json').length,ledgerGets);
 assert.equal(installed.calls.batches.length,before+4);
}

{
 const installed=await appliedInstall();
 sql(installed.productionFile,"INSERT INTO discovery_decision (observation_key, generation, decision_hash, payload_json) VALUES ('obs-1', 0, 'hash', '{}');");
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(refused.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_decision;',{json:true})[0].n,1);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 sql(installed.productionFile,"INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, payload_json) VALUES ('active', 'other', 'retiring', 'run-old', '{}');");
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(sql(installed.productionFile,"SELECT residence FROM discovery_observation WHERE observation_key='other';",{json:true})[0].residence,'retiring');
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 sql(installed.productionFile,"UPDATE discovery_authority SET mode='d1' WHERE id=1;");
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'marker_refused');
 assert.equal(refused.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 placeLedger(installed,{programmeRunId:'run-old',items:[sample]});
 sql(installed.productionFile,"UPDATE discovery_checkpoint SET hop_id='seal' WHERE id=1; UPDATE discovery_transfer SET state='loading' WHERE id=1;");
 const refused=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 const reset=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(reset.exit,3,JSON.stringify(reset.result));
 assert.equal(reset.result.reason,'partial_mismatch');
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'seal');
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 const cleared=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(cleared.exit,0,JSON.stringify(cleared.result));
 assert.equal(cleared.result.reason,'already_reset');
 assert.equal(cleared.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
}

{
 const installed=await install(10);
 seed(installed);
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'schema_unexpected');
 assert.equal(refused.result.writes,false);
 assert.equal(installed.calls.batches.length,0);
}

{
 const installed=await appliedInstall();
 installed.putObject('sync.json',{stage:'epg',updatedAt:'2026-11-04T11:50:00.000Z'});
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'writer_active');
 assert.equal(installed.calls.gets.includes('epg/discovery-latest.json'),false);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 sql(installed.productionFile,"INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, payload_json) VALUES ('active', 'hand', 'active', 'run-old', '{}');");
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(refused.result.writes,false);
 assert.equal(sql(installed.productionFile,"SELECT observation_key FROM discovery_observation;",{json:true})[0].observation_key,'hand');
 assert.equal(installed.calls.batches.length,1);
}

{
 const {installed,before}=await tornCommit();
 sql(installed.productionFile,"INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, payload_json) VALUES ('active', 'other-run', 'active', 'other-run', '{}');");
 const refused=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(refused.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,2);
 assert.equal(installed.calls.batches.length,before+3);
}

{
 const {installed,before}=await tornCommit();
 installed.control.beforeBatch=batch=>{
  if(batch.some(sql=>sql.startsWith('DELETE FROM discovery_observation ')))sql(installed.productionFile,"UPDATE discovery_checkpoint SET payload_json='{}' WHERE id=1;");
 };
 const raced=await run(['--reset-load','--confirm','reset-load','--target','iptv'], installed);
 assert.equal(raced.exit,3,JSON.stringify(raced.result));
 assert.equal(raced.result.reason,'d1_statement');
 assert.equal(raced.result.writes,null);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,"SELECT observation_key FROM discovery_observation;",{json:true})[0].observation_key,'obs-1');
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'loading');
 assert.equal(sql(installed.productionFile,'SELECT generation FROM ratings_domain_authority WHERE id=1;',{json:true})[0].generation,12);
 assert.equal(installed.calls.batches.length,before+4);
}

{
 const adapter=createD1Adapter({target:{accountId:PRODUCTION_ACCOUNT_ID,apiToken:TOKEN,endpoint:'https://api.cloudflare.com/client/v4'},databaseId:PRODUCTION_DATABASE_ID,fetchImpl(){throw new Error('sent');}});
 await assert.rejects(()=>adapter.inspect('UPDATE schema_contract SET version=11'),error=>error.kind==='statement');
}

const loadedSnapshot={schemaVersion:11,marker:{mode:'r2',cutover:'open',generation:1,programmeRunId:'run-old',publishedProgrammeRunId:'run-old'},transfer:{state:'committed',programmeRunId:'run-old',batches:1},checkpoint:{hopId:null,payload:null}};
assert.equal(importDecision({...loadedSnapshot,marker:{mode:'r2',cutover:'open',generation:0,programmeRunId:null,publishedProgrammeRunId:null},transfer:{state:'idle',programmeRunId:null,batches:0}}),'ledger_required');
assert.equal(importDecision(loadedSnapshot),'import');
assert.equal(importDecision({...loadedSnapshot,checkpoint:{hopId:'import',payload:'{}'}}),'partial_import');
assert.equal(holdDecision(loadedSnapshot),'import_required');
assert.equal(holdDecision({...loadedSnapshot,checkpoint:{hopId:'imported',payload:'{}',programmeRunId:'run-old'}}),'hold');
assert.equal(holdDecision({...loadedSnapshot,marker:{...loadedSnapshot.marker,mode:'d1',cutover:'held'}}),'already_held');
assert.equal(activateDecision({...loadedSnapshot,marker:{...loadedSnapshot.marker,mode:'d1',cutover:'held'},checkpoint:{hopId:'imported',payload:'{}'}}),'activate');
assert.equal(activateDecision({...loadedSnapshot,marker:{...loadedSnapshot.marker,mode:'d1',cutover:'held'}}),'marker_refused');
assert.equal(activateDecision({...loadedSnapshot,marker:{...loadedSnapshot.marker,mode:'d1',cutover:'open'}}),'already_active');
assert.throws(()=>catalogEntries({'':{tmdbId:1,canonicalIdentity:'tmdb:1'}}),error=>error.reason==='import_refused');
const decisions=decisionEntries({'b':{status:'matched',evidenceKey:'keep'},'a':{status:'matched',evidenceKey:'other'},'__canonicalizedAt':'2026-11-04T00:00:00.000Z'});
assert.deepEqual(decisions.map(row=>row.key),['a','b']);
assert.equal(staleEvidenceCount(decisions,new Map([['a','other'],['b','moved']])),1);
assert.equal(staleEvidenceCount(decisions,new Map([['b','moved']])),1);
assert.equal(staleEvidenceCount([{key:'gone',decision:{evidenceKey:'old'}}],new Map()),0);
assert.equal(staleEvidenceCount([{key:'plain',decision:{status:'matched'}}],new Map([['plain','other']])),0);
assert.deepEqual(scoreEntries({schemaVersion:1,mode:'on',programmeRunId:'run-other',items:{'obs-1':{observationKey:'obs-1',outcome:'keep'}}},'run-old'),[]);
assert.equal(scoreEntries({schemaVersion:1,mode:'on',programmeRunId:'run-old',items:{'obs-1':{observationKey:'obs-1',outcome:'keep'}}},'run-old')[0].observationKey,'obs-1');
assert.throws(()=>scoreEntries({programmeRunId:'run-old',items:Object.fromEntries(Array.from({length:65},(_,index)=>[String(index),{observationKey:String(index)}]))},'run-old'),error=>error.reason==='import_refused');
assert.equal(valuePrefix([{filmId:'a'}],[{filmId:'a'},{filmId:'b'}],(left,right)=>left.filmId===right.filmId).cursor,1);
assert.equal(valuePrefix([{filmId:'b'}],[{filmId:'a'}],(left,right)=>left.filmId===right.filmId).mismatch,true);
const manyDecisions=Array.from({length:101},(_,index)=>['INSERT '+index,'HISTORY '+index]);
const packedDecisions=packImportBatches(manyDecisions);
assert.equal(packedDecisions.flat().filter(sql=>sql.startsWith('INSERT ')).length,101);
assert.equal(packedDecisions.some(batch=>batch.some(sql=>sql.includes('discovery_transfer'))),false);
assert.equal(packedDecisions.every(batch=>batch.length<=100),true);
const held=holdSql({programmeRunId:'run-old',generation:1,batches:4,payload:'{"pin":true}'});
assert.match(held[0],/hop_id='imported'/);
assert.match(held[1],/mode='d1', cutover='held'/);
assert.equal(held.join('\n').includes('generation+1'),false);
const opened=activateSql({programmeRunId:'run-old',generation:1,batches:4,payload:'{"pin":true}'});
assert.match(opened[1],/cutover='open'/);
assert.match(opened[0],/cutover='held'/);
assert.match(opened[2],/hop_id=NULL/);
assert.equal(opened.join('\n').includes('generation+1'),false);
const pin=importIdentity({programmeRunId:'run-old',generation:1,batches:1,catalog:{present:false},decisions:{present:false},status:{present:false},scores:{present:false},continuation:{present:false},workflow:{present:false}});
assert.equal(resetImportDecision({...loadedSnapshot,sideRows:0}),'already_reset');
assert.equal(resetImportDecision({...loadedSnapshot,sideRows:2}),'partial_mismatch');
assert.equal(resetImportDecision({...loadedSnapshot,sideRows:1,checkpoint:{hopId:'imported',payload:pin,programmeRunId:'run-old'}}),'reset_import');
const importResetStatements=resetImportSql({hop:'imported',programmeRunId:'run-old',generation:1,batches:1,payload:pin,observations:4});
assert.equal(importResetStatements.some(sql=>sql.includes('DELETE FROM discovery_observation')),false);
assert.equal(importResetStatements.some(sql=>sql.includes('DELETE FROM discovery_admission')),true);
assert.equal(importResetStatements.join('\n').includes('generation+1'),false);

{
 const installed=await appliedInstall();
 sql(installed.productionFile,`UPDATE discovery_authority SET generation=1, programme_run_id='run-old', published_programme_run_id='run-old' WHERE id=1;
UPDATE discovery_transfer SET state='committed', programme_run_id='run-old', batches=1 WHERE id=1;
UPDATE discovery_checkpoint SET hop_id='import', payload_json='{}' WHERE id=1;`);
 const heldEarly=await run(['--hold','--confirm','hold','--producers-drained','--target','iptv'], installed);
 assert.equal(heldEarly.exit,3,JSON.stringify(heldEarly.result));
 assert.equal(heldEarly.result.reason,'partial_import');
 assert.equal(heldEarly.result.writes,false);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM discovery_authority WHERE id=1;",{json:true})[0].mode,'r2');
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 const early=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(early.exit,3,JSON.stringify(early.result));
 assert.equal(early.result.reason,'ledger_required');
 assert.equal(early.result.writes,false);
 assert.equal(installed.calls.batches.length,1);
}

{
 const installed=await appliedInstall();
 const item={key:'obs-1',title:'Kept',normalizedTitle:'kept',year:1999,shows:[]};
 const key=evidenceKey(item);
 sql(installed.productionFile,`UPDATE discovery_authority SET generation=1, programme_run_id='run-old', published_programme_run_id='run-old' WHERE id=1;
UPDATE discovery_transfer SET state='committed', programme_run_id='run-old', batches=1 WHERE id=1;
INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, evidence_key, payload_json) VALUES ('active','obs-1','active','run-old','${key}','{}');`);
 const film={'film-1':{tmdbId:'7',canonicalIdentity:'tmdb:7',observationKey:'obs-1',title:'Kept'}};
 const resolution={__canonicalizedAt:'2026-11-04T00:00:00.000Z','obs-1':{status:'matched',evidenceKey:key,tmdbId:'7',filmId:'film-1',canonicalIdentity:'tmdb:7'}};
 const status={schemaVersion:2,stage:'complete',programmeRunId:'run-old'};
 const scores={schemaVersion:1,mode:'on',programmeRunId:'run-old',items:{'obs-1':{observationKey:'obs-1',outcome:'keep',reason:'fit'}}};
 const continuation={programmeRunId:'run-old',stage:'paused'};
 const workflow={instanceId:'wf-1',programmeRunId:'run-old',series:1,stage:'idle'};
 const put=(objectKey,value,etag)=>installed.putObject(objectKey,value,{etag});
 put('epg/discovered-films.json',film,'catalog-etag');
 put('epg/generations/run-old/discovered-films.json',film,'catalog-etag');
 put('epg/discovery-resolution.json',resolution,'resolution-etag');
 put('epg/discovery-status.json',status,'status-etag');
 put('epg/discovery-score-preview.json',scores,'score-etag');
 put('epg/resolver-continuation.json',continuation,'continuation-etag');
 put('epg/discovery-workflow.json',workflow,'workflow-etag');
 const mismatched=JSON.parse(JSON.stringify(resolution));
 mismatched['obs-1'].evidenceKey='different';
 installed.putObject('epg/discovery-resolution.json',mismatched,{etag:'resolution-etag'});
 installed.putObject('epg/discovery-score-preview.json',{schemaVersion:1,mode:'on',programmeRunId:'run-other',items:{'obs-1':{observationKey:'obs-1',outcome:'keep',reason:'fit'}}},{etag:'score-etag'});
 const drifted=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(drifted.exit,0,JSON.stringify(drifted.result));
 assert.equal(drifted.result.writes,true);
 assert.equal(drifted.result.staleEvidence,1);
 assert.equal(drifted.result.scores,0);
 assert.equal(sql(installed.productionFile,"SELECT evidence_key FROM discovery_decision WHERE observation_key='obs-1';",{json:true})[0].evidence_key,'different');
 assert.equal(sql(installed.productionFile,"SELECT evidence_key FROM discovery_observation WHERE observation_key='obs-1';",{json:true})[0].evidence_key,key);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_score;',{json:true})[0].n,0);
 const cleared=await run(['--reset-import','--confirm','reset-import','--producers-drained','--target','iptv'], installed);
 assert.equal(cleared.exit,0,JSON.stringify(cleared.result));
 assert.equal(cleared.result.writes,true);
 installed.putObject('epg/discovery-resolution.json',resolution,{etag:'resolution-etag'});
 installed.putObject('epg/discovery-score-preview.json',scores,{etag:'score-etag'});
 installed.control.failAt=installed.calls.batches.length+2;
 const interrupted=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(interrupted.exit,4,JSON.stringify(interrupted.result));
 assert.equal(interrupted.result.writeState,'unknown');
 assert.equal(sql(installed.productionFile,"SELECT hop_id FROM discovery_checkpoint WHERE id=1;",{json:true})[0].hop_id,'import');
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,0);
 installed.control.failAt=null;
 const imported=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(imported.exit,0,JSON.stringify(imported.result));
 assert.equal(imported.result.resumed,true);
 assert.equal(imported.result.mode,'r2');
 assert.equal(imported.result.generation,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_decision;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_decision_history;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,"SELECT payload_json FROM discovery_decision;",{json:true})[0].payload_json.includes('__canonicalizedAt'),false);
 assert.equal(sql(installed.productionFile,"SELECT state FROM discovery_transfer WHERE id=1;",{json:true})[0].state,'committed');
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'imported');
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_segment;',{json:true})[0].n,0);
 assert.equal(installed.calls.gets.includes('epg/discovery-segments.json'),false);
 const again=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(again.exit,0,JSON.stringify(again.result));
 assert.equal(again.result.reason,'already_imported');
 assert.equal(again.result.writes,false);
 const repeatLoad=await run(['--load','--confirm','load','--target','iptv'], installed);
 assert.equal(repeatLoad.exit,3,JSON.stringify(repeatLoad.result));
 assert.equal(repeatLoad.result.reason,'already_loaded');
 assert.equal(repeatLoad.result.writes,false);
 const heldRun=await run(['--hold','--confirm','hold','--producers-drained','--target','iptv'], installed);
 assert.equal(heldRun.exit,0,JSON.stringify(heldRun.result));
 assert.equal(heldRun.result.mode,'d1');
 assert.equal(heldRun.result.cutover,'held');
 assert.equal(heldRun.result.generation,1);
 const openedRun=await run(['--activate','--confirm','activate','--producers-drained','--target','iptv'], installed);
 assert.equal(openedRun.exit,0,JSON.stringify(openedRun.result));
 assert.equal(openedRun.result.mode,'d1');
 assert.equal(openedRun.result.cutover,'open');
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
 assert.equal(sql(installed.productionFile,'SELECT lease_id FROM discovery_lease WHERE id=1;',{json:true})[0].lease_id,null);
}

async function prepareDiscoverySource(){
 const installed=await appliedInstall();
 const item={key:'obs-1',title:'Kept',normalizedTitle:'kept',year:1999,shows:[]};
 const key=evidenceKey(item);
 sql(installed.productionFile,`UPDATE discovery_authority SET generation=1, programme_run_id='run-old', published_programme_run_id='run-old' WHERE id=1;
UPDATE discovery_transfer SET state='committed', programme_run_id='run-old', batches=1 WHERE id=1;
INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, evidence_key, payload_json) VALUES ('active','obs-1','active','run-old','${key}','{}');`);
 const film={'film-1':{tmdbId:'7',canonicalIdentity:'tmdb:7',observationKey:'obs-1',title:'Kept'}};
 const resolution={'obs-1':{status:'matched',evidenceKey:key,tmdbId:'7',filmId:'film-1',canonicalIdentity:'tmdb:7'}};
 const publish=(catalog,resolutionBody,catalogEtag,resolutionEtag)=>{
  installed.putObject('epg/discovered-films.json',catalog,{etag:catalogEtag});
  installed.putObject('epg/generations/run-old/discovered-films.json',catalog,{etag:catalogEtag});
  installed.putObject('epg/discovery-resolution.json',resolutionBody,{etag:resolutionEtag});
 };
 installed.putObject('epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:'run-old'},{etag:'status-etag'});
 installed.putObject('epg/discovery-score-preview.json',{schemaVersion:1,mode:'on',programmeRunId:'run-old',items:{'obs-1':{observationKey:'obs-1',outcome:'keep',reason:'fit'}}},{etag:'score-etag'});
 installed.putObject('epg/resolver-continuation.json',{programmeRunId:'run-old',stage:'paused'},{etag:'continuation-etag'});
 installed.putObject('epg/discovery-workflow.json',{instanceId:'wf-1',programmeRunId:'run-old',series:1,stage:'idle'},{etag:'workflow-etag'});
 publish(film,resolution,'catalog-etag','resolution-etag');
 return {installed,key,film,resolution,publish};
}
async function stageDiscoveryImport(){
 const prepared=await prepareDiscoverySource();
 const imported=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], prepared.installed);
 assert.equal(imported.exit,0,JSON.stringify(imported.result));
 return prepared;
}

{
 const {installed,key,publish}=await stageDiscoveryImport();
 const changed={'film-1':{tmdbId:'7',canonicalIdentity:'tmdb:7',observationKey:'obs-1',title:'Retitled'},'film-2':{tmdbId:'8',canonicalIdentity:'tmdb:8',title:'Added'}};
 const changedResolution={'obs-1':{status:'review',evidenceKey:key,tmdbId:'7',filmId:'film-1',canonicalIdentity:'tmdb:7'}};
 publish(changed,changedResolution,'catalog-etag-2','resolution-etag-2');
 const held=await run(['--hold','--confirm','hold','--producers-drained','--target','iptv'], installed);
 assert.equal(held.exit,3,JSON.stringify(held.result));
 assert.equal(held.result.reason,'source_changed');
 assert.equal(held.result.writes,false);
 assert.equal(sql(installed.productionFile,"SELECT mode FROM discovery_authority WHERE id=1;",{json:true})[0].mode,'r2');
 const replay=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(replay.exit,3,JSON.stringify(replay.result));
 assert.equal(replay.result.reason,'source_changed');
 assert.equal(replay.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,1);
 const reset=await run(['--reset-import','--confirm','reset-import','--producers-drained','--target','iptv'], installed);
 assert.equal(reset.exit,0,JSON.stringify(reset.result));
 assert.equal(reset.result.writes,true);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_decision;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
 assert.equal(sql(installed.productionFile,'SELECT generation FROM discovery_authority WHERE id=1;',{json:true})[0].generation,1);
 const copied=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(copied.exit,0,JSON.stringify(copied.result));
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,2);
 const titles=sql(installed.productionFile,'SELECT payload_json FROM discovery_admission ORDER BY film_id;',{json:true}).map(row=>JSON.parse(row.payload_json).title);
 assert.deepEqual(titles,['Retitled','Added']);
 assert.equal(JSON.parse(sql(installed.productionFile,'SELECT payload_json FROM discovery_decision;',{json:true})[0].payload_json).status,'review');
 const opened=await run(['--hold','--confirm','hold','--producers-drained','--target','iptv'], installed);
 assert.equal(opened.exit,0,JSON.stringify(opened.result));
 assert.equal(opened.result.mode,'d1');
 assert.equal(opened.result.cutover,'held');
 assert.equal(opened.result.generation,1);
 const pin=JSON.parse(sql(installed.productionFile,'SELECT payload_json FROM discovery_checkpoint WHERE id=1;',{json:true})[0].payload_json);
 assert.equal(pin.catalog.etag.includes('catalog-etag-2'),true);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
}

{
 const {installed,publish,key}=await stageDiscoveryImport();
 const film={'film-1':{tmdbId:'7',canonicalIdentity:'tmdb:7',observationKey:'obs-1',title:'Kept'}};
 publish(film,{'obs-1':{status:'matched',evidenceKey:key,tmdbId:'7',filmId:'film-1',canonicalIdentity:'tmdb:7'}},'catalog-etag','resolution-etag-moved');
 installed.control.failAt=null;
 const stale=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(stale.exit,3,JSON.stringify(stale.result));
 assert.equal(stale.result.reason,'source_changed');
 assert.equal(stale.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'imported');
 const reset=await run(['--reset-import','--confirm','reset-import','--producers-drained','--target','iptv'], installed);
 assert.equal(reset.exit,0,JSON.stringify(reset.result));
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 const copied=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(copied.exit,0,JSON.stringify(copied.result));
 assert.equal(JSON.parse(sql(installed.productionFile,'SELECT payload_json FROM discovery_checkpoint WHERE id=1;',{json:true})[0].payload_json).decisions.etag.includes('resolution-etag-moved'),true);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
}

{
 const {installed}=await prepareDiscoverySource();
 installed.control.failAt=installed.calls.batches.length+2;
 const interrupted=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(interrupted.exit,4,JSON.stringify(interrupted.result));
 assert.equal(interrupted.result.writeState,'unknown');
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'import');
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,0);
 installed.objects.get('epg/discovery-resolution.json').etag='resolution-during-import';
 installed.control.failAt=null;
 const stalled=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(stalled.exit,3,JSON.stringify(stalled.result));
 assert.equal(stalled.result.reason,'source_changed');
 assert.equal(stalled.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,'import');
 const reset=await run(['--reset-import','--confirm','reset-import','--producers-drained','--target','iptv'], installed);
 assert.equal(reset.exit,0,JSON.stringify(reset.result));
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,0);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_observation;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT hop_id FROM discovery_checkpoint WHERE id=1;',{json:true})[0].hop_id,null);
 const copied=await run(['--import','--confirm','import','--producers-drained','--target','iptv'], installed);
 assert.equal(copied.exit,0,JSON.stringify(copied.result));
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_decision;',{json:true})[0].n,1);
 assert.equal(JSON.parse(sql(installed.productionFile,'SELECT payload_json FROM discovery_checkpoint WHERE id=1;',{json:true})[0].payload_json).decisions.etag.includes('resolution-during-import'),true);
}

{
 const {installed}=await stageDiscoveryImport();
 sql(installed.productionFile,"INSERT INTO discovery_segment (source_key, programme_run_id, residence, content_sha256, item_count) VALUES ('archive:run-old:1:a','run-old','archive','abc',1);");
 const refused=await run(['--reset-import','--confirm','reset-import','--producers-drained','--target','iptv'], installed);
 assert.equal(refused.exit,3,JSON.stringify(refused.result));
 assert.equal(refused.result.reason,'partial_mismatch');
 assert.equal(refused.result.writes,false);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_admission;',{json:true})[0].n,1);
 assert.equal(sql(installed.productionFile,'SELECT COUNT(*) AS n FROM discovery_segment;',{json:true})[0].n,1);
}
