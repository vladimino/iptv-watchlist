// ADR 0078, ADR 0162. The production entry stays read-only unless a command names iptv and its own confirm. The load, activate, release, reconcile and revert
// commands of the former R2 to D1 cutover are retired and refused before any request; status, the schema apply and the fingerprint body repair remain.
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
import {sqliteSync} from './sqlite-session.mjs';

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
for(const command of ['--load','--activate','--revert','--release','--reconcile']){
 const retired=spawnSync(process.execPath,[script,command,'--confirm','x','--target','iptv'],{encoding:'utf8'});
 assert.equal(retired.status,2,command);
 assert.match(retired.stderr,/retired/,command);
}

const calls={n:0};
const quiet=await runPredictionDomainProduction({argv:argv(),fetchImpl(){calls.n++;throw new Error('network');}});
assert.equal(quiet.exit,0);
assert.equal(quiet.result.writes,false);
assert.equal(calls.n,0);
for(const command of ['--load','--activate','--revert','--release','--reconcile']){
 let touched=0;
 const refused=await runPredictionDomainProduction({argv:argv(command,'--confirm','x','--target','iptv'),binding:{prepare(){touched++;throw new Error('binding used');}},fetchImpl(){touched++;throw new Error('network');}});
 assert.equal(refused.exit,2,command);
 assert.equal(refused.result.reason,'retired',command);
 assert.equal(refused.result.writes,false);
 assert.equal(touched,0,command+' is refused before any request');
}

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


// Status reads the marker without the Worker's refusal: an operator must see an uninstalled domain and a marker in mode r2 (which the Worker refuses, ADR 0162).
{
 const status=async db=>(await run(['--target','iptv'],db,undefined)).result;
 const none=await status(migrated('0006_metadata_cache'));
 assert.deepEqual([none.tables,none.mode,none.writes],[false,null,false],'writes is the no-write flag of the command, not the marker');
 const fresh=await status(migrated('0007_prediction_authority'));
 assert.deepEqual([fresh.tables,fresh.mode,fresh.schemaVersion,fresh.generation],[true,'r2',7,0]);
 const served=migrated('0007_prediction_authority');served.sql("UPDATE prediction_domain_authority SET mode='d1', writes='held'");
 const live=await status(served);
 assert.deepEqual([live.tables,live.mode],[true,'d1'],'a d1 marker with writes held is the normal activated state');
 assert.equal(live.configured,true);
}

const ACCOUNT_ID=PRODUCTION_ACCOUNT_ID;
function installEnv(bucket,endpoint){
 return {R2_INSTALL_ACCESS_KEY_ID:'install-key',R2_INSTALL_SECRET_ACCESS_KEY:'install-secret',R2_INSTALL_ACCOUNT_ID:ACCOUNT_ID,R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT_ID,R2_SNAPSHOT_BUCKET:bucket,...(endpoint?{R2_SNAPSHOT_ENDPOINT:endpoint}:{})};
}

const ACCOUNT='0123456789abcdef0123456789abcdef';
const TOKEN='test-d1-token';
const TARGET='11111111-1111-4111-8111-111111111111';
const DROP_TARGET='33333333-3333-4333-8333-333333333333';
const ROLL_TARGET='44444444-4444-4444-8444-444444444444';
function sqliteFile(file,input){const result=sqliteSync(['-bail',file],{input,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;}
function httpDatabases(){
 const files={
  [TARGET]:migrated('0006_metadata_cache').file,
  [DROP_TARGET]:migrated('0006_metadata_cache').file,
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
   const result=sqliteSync(['-json','-bail',files[match[2]]],{input,encoding:'utf8',maxBuffer:1<<28});
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
await adapterFor(ROLL_TARGET).executeSql(['CREATE TABLE batch_ok (id INTEGER PRIMARY KEY)','INSERT INTO batch_ok (id) VALUES (1)']);
const rollAdapter=adapterFor(ROLL_TARGET);
await assert.rejects(rollAdapter.executeSql(['INSERT INTO batch_ok (id) VALUES (2)','INSERT INTO batch_missing (id) VALUES (1)']),error=>error.kind==='statement');
assert.equal(sqliteFile(files[ROLL_TARGET],'SELECT COUNT(*) FROM batch_ok;').trim(),'1');
const rolled=fake.calls.filter(call=>call.database===ROLL_TARGET&&/batch_missing/.test(call.sql));
assert.equal(rolled.length,1);
assert.equal(rolled[0].batch,false);
assert.match(rolled[0].sql,/VALUES \(2\)/);


// A response lost after a committed write is write_uncertain with writeState unknown, and is not retried (the schema apply carries the same guard).
fake.hooks.push(({write,phase})=>{if(write&&phase==='after')return 'drop';});
const dropWritesAt=fake.calls.filter(call=>call.database===DROP_TARGET&&call.write).length;
const dropped=await run(drained,createPredictionBinding(adapterFor(DROP_TARGET)),new MemoryBucket());
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
assert.equal(headFailed.result.detail.name,'Error');
assert.equal(headFailed.result.detail.phase,'before-put');
assert.equal(headFailed.result.detail.message,'head down');
assert.equal(headFailed.result.detail.stack,undefined);
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
const detailDb=migrated('0007_prediction_authority');
const detailBucket=new MemoryBucket();
const hiddenHash='a'.repeat(64);
await put(detailBucket,'enrichment/films/film:tmdb:9/fingerprint.json',{fingerprintHash:'b'.repeat(64)});
const rawDetailGet=detailBucket.get.bind(detailBucket);
detailBucket.get=async key=>{
 if(String(key).endsWith('/fingerprint.json')){
  const error=new Error('parse enrichment/films/film:tmdb:9/fingerprint.json '+hiddenHash+' bearer token=supersecret https://user:pass@example.com/films/film:tmdb:9/fingerprint.json');
  error.kind='network';
  error.code='ECONNRESET';
  error.details={body:'should not leak'};
  throw error;
 }
 return rawDetailGet(key);
};
const detailed=await run(['--materialize-fingerprints','--confirm','materialize','--target','iptv'],detailDb,detailBucket);
assert.equal(detailed.exit,1);
assert.equal(detailed.result.reason,'failed');
assert.equal(detailed.result.writes,false);
assert.equal(detailed.result.writeState,'none');
assert.equal(detailed.result.detail.name,'Error');
assert.equal(detailed.result.detail.kind,'network');
assert.equal(detailed.result.detail.code,'ECONNRESET');
assert.equal(detailed.result.detail.details,undefined);
assert.match(detailed.result.detail.message,/enrichment\/films\/\[id\]\/fingerprint\.json/);
assert.match(detailed.result.detail.message,/https:\/\/example.com\/films\/\[id\]\/fingerprint\.json/);
assert.doesNotMatch(detailed.result.detail.message,/film:tmdb:9/);
assert.doesNotMatch(detailed.result.detail.message,/supersecret/);
assert.doesNotMatch(detailed.result.detail.message,new RegExp(hiddenHash));
assert.equal(one(detailDb,'SELECT COUNT(*) FROM prediction_fingerprint'),0);
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

console.log('prediction domain production entry: the cutover commands are retired and refused before any request; status, the schema apply and the fingerprint body repair fail closed without a network call');
