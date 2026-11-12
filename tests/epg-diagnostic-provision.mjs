// AIR-456 H1. The operator script of the EPG diagnostic domain (`scripts/epg-diagnostic-provision.mjs`), offline: a fake D1 REST endpoint over a sqlite file, an in-memory bucket and the
// Worker's own `EpgDiagnostic.assess` / `provision`. No Cloudflare, no network, no credential. What is proved:
//   1. Configuration: the production database id, the production bucket and any non-diagnostic bucket are refused before a request; secrets are never in a report.
//   2. Target: the database read back must be the configured uuid and the diagnostic name; anything else stops after the one metadata read.
//   3. `check` and every dry run write nothing; `--apply` needs its own confirmation string; `check` has no apply.
//   4. `schema` applies the production chain and the diagnostic migrations, in order, one request per file, only to a database with no tables; stops at the first failure, never retries a write;
//      afterwards the domain is in exactly the state `provision` requires.
//   5. `identity` is the Worker's own judgement (`assess`, then `provision`): refused on a used bucket or database, written once with a D1 and R2 readback, refused the second time.
//   6. The bucket handle the operator hands over writes only the identity object and never deletes.
//   7. Mutation checks: each guard removed from the script is caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {bucket} from './discovery-bounded-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-diag-provision-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const SCRIPT=path.resolve('scripts/epg-diagnostic-provision.mjs');
const SOURCE=fs.readFileSync(SCRIPT,'utf8');
const ACCOUNT='a'.repeat(32),DBID='11111111-2222-4333-8444-555555555555',TOKEN='tok-SECRET-token-value',KEY='r2-key-ID-value',SECRET='r2-SECRET-access-value',RESOURCE='epg-diag-20261112';
const BASE='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+DBID;
const env=(extra={})=>({EPG_DIAGNOSTIC_ACCOUNT_ID:ACCOUNT,EPG_DIAGNOSTIC_D1_DATABASE_ID:DBID,EPG_DIAGNOSTIC_D1_API_TOKEN:TOKEN,EPG_DIAGNOSTIC_R2_ACCESS_KEY_ID:KEY,EPG_DIAGNOSTIC_R2_SECRET_ACCESS_KEY:SECRET,EPG_DIAGNOSTIC_RESOURCE_ID:RESOURCE,...extra});
let counter=0;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

// A fake D1 REST endpoint over a sqlite file: GET database -> its metadata; POST query {sql}: a single SELECT answers its rows, anything else is executed as a script (all or nothing for
// the failing statement, as `-bail` does) and answers one success. Every request is logged; a write whose text matches `throwOn` fails in transit.
function fakeD1({name='iptv-epg-diagnostic',uuid=DBID,throwOn=null,readBody=null}={}){
 const file=path.join(root,'d-'+(counter++)+'.sqlite'),log=[];
 const fetchImpl=async(url,init={})=>{
  const target=String(url),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
  log.push({method,url:target,sql:body?.sql??null});
  if(!target.startsWith(BASE))throw new Error('unexpected host '+target);
  if(method==='GET'&&target===BASE)return json({success:true,result:{uuid,name}});
  if(method==='POST'&&target===BASE+'/query'){
   const sql=body.sql;
   if(throwOn&&throwOn(sql))throw new Error('connection reset');
   const read=/^\s*SELECT\b/i.test(sql)&&!/;\s*\S/.test(sql.trim());
   if(read&&readBody)return json(readBody);
   const result=sqliteSync([...(read?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});
   if(result.status!==0)return json({success:false,errors:[{message:String(result.stderr).trim()}]},400);
   if(read){const out=String(result.stdout).trim();return json({success:true,result:[{success:true,results:out?JSON.parse(out):[],meta:{rows_written:0}}]});}
   return json({success:true,result:[{success:true}]});
  }
  throw new Error('unexpected request '+method+' '+target);
 };
 return {file,log,fetchImpl,tables:()=>sqliteSync([file,"SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"],{encoding:'utf8'}).stdout.trim(),
  writes:()=>log.filter(entry=>entry.method==='POST'&&!/^\s*SELECT\b/i.test(entry.sql||'')).length};
}
const sqlRows=(file,sql)=>{const r=sqliteSync(['-json',file,sql],{encoding:'utf8'});const out=String(r.stdout).trim();return out?JSON.parse(out):[];};
const failure=async work=>{try{await work();return null;}catch(error){return error;}};

async function scenarios(api){
 const results={};
 const apply=(command,extra={})=>({command,apply:true,confirm:api.CONFIRM[command],...extra});
 const checks={
  'the production database id is refused':async()=>{const d=fakeD1();const e=await failure(()=>api.run({command:'check',env:env({EPG_DIAGNOSTIC_D1_DATABASE_ID:api.PRODUCTION.databaseId}),fetchImpl:d.fetchImpl,store:bucket()}));return e?.exitCode===3&&d.log.length===0;},
  'the production bucket is refused':async()=>{const d=fakeD1();const a=await failure(()=>api.run({command:'check',env:env({EPG_DIAGNOSTIC_R2_BUCKET:'iptv'}),fetchImpl:d.fetchImpl,store:bucket()}));const b=await failure(()=>api.run({command:'check',env:env({EPG_DIAGNOSTIC_R2_BUCKET:'other-bucket'}),fetchImpl:d.fetchImpl,store:bucket()}));return !!a&&!!b&&d.log.length===0;},
  'the database name must be the diagnostic one':async()=>{const d=fakeD1({name:'other-db'});const e=await failure(()=>api.run({command:'check',env:env(),fetchImpl:d.fetchImpl,store:bucket()}));return e?.exitCode===3&&d.log.length===1&&d.log[0].method==='GET';},
  'the database uuid read back must match':async()=>{const d=fakeD1({uuid:'99999999-2222-4333-8444-555555555555'});const e=await failure(()=>api.run({command:'check',env:env(),fetchImpl:d.fetchImpl,store:bucket()}));return e?.exitCode===3&&d.log.length===1;},
  'apply needs its confirmation':async()=>{const d=fakeD1();const a=await failure(()=>api.run({command:'schema',apply:true,confirm:null,env:env(),fetchImpl:d.fetchImpl,store:bucket()}));const b=await failure(()=>api.run({command:'identity',apply:true,confirm:api.CONFIRM.schema,env:env(),fetchImpl:d.fetchImpl,store:bucket()}));const c=await failure(()=>api.run({command:'check',apply:true,confirm:'x',env:env(),fetchImpl:d.fetchImpl,store:bucket()}));return a?.exitCode===2&&b?.exitCode===2&&c?.exitCode===2&&d.log.length===0&&d.writes()===0;},
  'schema refuses a database with tables':async()=>{const d=fakeD1();sqliteSync([d.file,'CREATE TABLE stray (x)'],{encoding:'utf8'});const e=await failure(()=>api.run({...apply('schema'),env:env(),fetchImpl:d.fetchImpl,store:bucket()}));return e?.exitCode===3&&d.writes()===0;},
  'a malformed read does not prove an empty database':async()=>{
   for(const body of [{success:true,result:[]},{success:true,result:[{}]},{success:true,result:[{success:true}]},{success:true,result:[{success:true,results:'none'}]},{success:true,result:{}},{success:true},{success:true,result:[{success:true,results:[]},{success:true,results:[]}]},{success:true,result:[{success:false,results:[]}]}]){
    const d=fakeD1({readBody:body});const e=await failure(()=>api.run({...apply('schema'),env:env(),fetchImpl:d.fetchImpl,store:bucket()}));
    if(e?.exitCode!==3||d.writes()!==0)return false;
   }
   return true;},
  'an arbitrary endpoint is refused before any request':async()=>{
   let calls=0;const fetchImpl=async()=>{calls++;throw new Error('no request may be sent');};
   for(const extra of [{EPG_DIAGNOSTIC_API_ENDPOINT:'https://arbitrary-host.example'},{EPG_DIAGNOSTIC_API_ENDPOINT:'https://api.cloudflare.com.evil.example/client/v4'},{EPG_DIAGNOSTIC_API_ENDPOINT:'https://user:pass@api.cloudflare.com/client/v4'},{EPG_DIAGNOSTIC_API_ENDPOINT:'https://api.cloudflare.com/client/v4?x=1'},{EPG_DIAGNOSTIC_API_ENDPOINT:'https://api.cloudflare.com/other'},{EPG_DIAGNOSTIC_R2_ENDPOINT:'https://other.r2.cloudflarestorage.com'},{EPG_DIAGNOSTIC_R2_ENDPOINT:'https://arbitrary-host.example'}]){
    const e=await failure(()=>api.run({command:'check',env:env(extra),fetchImpl,store:bucket()}));
    if(e?.exitCode!==2)return false;
   }
   return calls===0;},
  'the bucket handle writes only the identity object':async()=>{const store=bucket();const guarded=api.guardedBucket(store);const a=await failure(()=>guarded.put('epg/generation.json','{}',{onlyIf:{etagDoesNotMatch:'*'}}));const b=await failure(()=>guarded.delete('diagnostic/identity.json'));return !!a&&!!b&&store.objects.size===0;},
 };
 for(const [name,run] of Object.entries(checks)){try{results[name]=(await run())===true;}catch{results[name]=false;}}
 return results;
}

const live=await import(pathToFileURL(SCRIPT).href);

// ---- 1-6: the real script -------------------------------------------------------------------------------------------------------------------------------------------------------------
{
 const results=await scenarios(live);
 assert.deepEqual(Object.entries(results).filter(([,ok])=>!ok).map(([name])=>name),[],'the real script passes every check');
}
{
 // configuration is strict and says nothing secret
 for(const [label,extra] of Object.entries({'no account':{EPG_DIAGNOSTIC_ACCOUNT_ID:''},'bad database id':{EPG_DIAGNOSTIC_D1_DATABASE_ID:'nope'},'no token':{EPG_DIAGNOSTIC_D1_API_TOKEN:''},'no r2 key':{EPG_DIAGNOSTIC_R2_ACCESS_KEY_ID:''},'bad resource id':{EPG_DIAGNOSTIC_RESOURCE_ID:'Bad_ID'},'plain http endpoint':{EPG_DIAGNOSTIC_API_ENDPOINT:'http://example.com'}})){
  const e=await failure(()=>live.readConfig(env(extra)));assert.equal(e?.exitCode,2,label);
 }
 assert.equal(live.readConfig(env({EPG_DIAGNOSTIC_API_ENDPOINT:'http://127.0.0.1:9999'})).endpoint,'http://127.0.0.1:9999','a loopback test server is allowed');
 assert.equal(live.readConfig(env({EPG_DIAGNOSTIC_API_ENDPOINT:'https://api.cloudflare.com/client/v4/'})).endpoint,'https://api.cloudflare.com/client/v4','the canonical endpoint written out is allowed');
 const EU='https://'+ACCOUNT+'.eu.r2.cloudflarestorage.com';
 assert.equal(live.readConfig(env()).r2Endpoint,EU,'the diagnostic bucket is reached on the EU endpoint of the account by default');
 assert.equal(live.readConfig(env({EPG_DIAGNOSTIC_R2_ENDPOINT:EU})).r2Endpoint,EU,'the canonical EU endpoint written out is allowed');
 assert.equal(live.readConfig(env({EPG_DIAGNOSTIC_R2_ENDPOINT:'http://127.0.0.1:9000'})).r2Endpoint,'http://127.0.0.1:9000','a loopback test server is allowed');
 const notEu=await failure(()=>live.readConfig(env({EPG_DIAGNOSTIC_R2_ENDPOINT:'https://'+ACCOUNT+'.r2.cloudflarestorage.com'})));assert.equal(notEu?.exitCode,2,'the default (non-EU) endpoint of the account is refused: it cannot reach an EU bucket');
 const usage=await failure(()=>live.run({command:'drop',env:env()}));assert.equal(usage?.exitCode,2);
}
{
 // check on an empty database: nothing is written, the state is reported, secrets are not in the report
 const d=fakeD1(),store=bucket();
 const report=await live.run({command:'check',env:env(),fetchImpl:d.fetchImpl,store});
 assert.equal(report.database.tables,0);assert.equal(report.assess.ok,false);assert.equal(report.assess.reason,'schema_missing');assert.deepEqual(report.writes,{d1:0,r2:0});
 assert.equal(d.writes(),0);assert.equal(store.objects.size,0);
 const text=JSON.stringify(report);for(const secret of [TOKEN,KEY,SECRET])assert.ok(!text.includes(secret),'no secret in a report');
}
{
 // schema: dry run lists the files and writes nothing; apply needs the confirmation; apply applies every file in order, one request each
 const d=fakeD1(),store=bucket();
 const dry=await live.run({command:'schema',env:env(),fetchImpl:d.fetchImpl,store});
 const production=fs.readdirSync('migrations').filter(name=>/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(name)).sort().map(name=>'migrations/'+name);
 const diagnostic=fs.readdirSync('diagnostic-migrations').filter(name=>/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(name)).sort().map(name=>'diagnostic-migrations/'+name);
 assert.deepEqual(dry.files.map(entry=>entry.file),[...production,...diagnostic],'the production chain first, then the diagnostic migrations');
 assert.equal(dry.mode,'dry-run');assert.equal(d.writes(),0);assert.equal(d.tables(),'0');
 const done=await live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:d.fetchImpl,store});
 assert.deepEqual(done.applied,[...production,...diagnostic]);assert.equal(d.writes(),production.length+diagnostic.length,'one request per file');
 assert.equal(done.assess.ok,true,'the domain is in the state `provision` requires: '+JSON.stringify(done.assess));assert.ok(done.database.tables>100);
 assert.equal(sqlRows(d.file,'SELECT version FROM schema_contract')[0].version,19);
 const sizeBefore=d.log.length;
 const again=await failure(()=>live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:d.fetchImpl,store}));
 assert.equal(again?.exitCode,3,'a second apply is refused');assert.equal(d.writes(),production.length+diagnostic.length,'and writes nothing');void sizeBefore;
 // identity: dry run judges without writing; apply writes D1 and R2 once and reads both back; a second apply is refused
 const plan=await live.run({command:'identity',env:env(),fetchImpl:d.fetchImpl,store});
 assert.equal(plan.assess.ok,true);assert.deepEqual(plan.writes,{d1:0,r2:0});assert.equal(store.objects.size,0);assert.equal(sqlRows(d.file,'SELECT count(*) AS n FROM epg_diagnostic_identity')[0].n,0);
 const written=await live.run({command:'identity',apply:true,confirm:live.CONFIRM.identity,env:env(),fetchImpl:d.fetchImpl,store});
 assert.equal(written.identity,'written');assert.deepEqual(written.readback.d1,{domain:'epg-diagnostic',resourceId:RESOURCE});assert.deepEqual(written.readback.r2,{domain:'epg-diagnostic',resourceId:RESOURCE});
 assert.deepEqual([...store.objects.keys()],['diagnostic/identity.json'],'the identity object is the only object written');
 const second=await failure(()=>live.run({command:'identity',apply:true,confirm:live.CONFIRM.identity,env:env(),fetchImpl:d.fetchImpl,store}));
 assert.equal(second?.exitCode,3);assert.match(second.message,/identity_exists/);assert.equal(store.objects.size,1);
 // check afterwards reports the verified identity state without writing
 const writesNow=d.writes();const after=await failure(()=>live.run({command:'check',env:env(),fetchImpl:d.fetchImpl,store}));void after;assert.equal(d.writes(),writesNow);
}
{
 // a failing migration stops the run at that file: no later file is sent, and a failed write is never repeated
 const d=fakeD1();
 const files=[{file:'migrations/0001_ok.sql',bytes:1,sha256:'x',text:'CREATE TABLE a (x);'},{file:'migrations/0002_bad.sql',bytes:1,sha256:'y',text:'CREATE TABLE a (x);'},{file:'migrations/0003_never.sql',bytes:1,sha256:'z',text:'CREATE TABLE c (x);'}];
 const e=await failure(()=>live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:d.fetchImpl,store:bucket(),files}));
 assert.equal(e?.exitCode,3);assert.equal(e.details.report.failedAt,'migrations/0002_bad.sql');assert.deepEqual(e.details.report.applied,['migrations/0001_ok.sql']);
 assert.equal(d.writes(),2,'the third file is never sent');assert.equal(d.tables(),'1');
 // an outcome that is not known (the connection failed after the request) is reported as such, and sent once
 const u=fakeD1({throwOn:sql=>sql.includes('CREATE TABLE a')});
 const lost=await failure(()=>live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:u.fetchImpl,store:bucket(),files:[files[0]]}));
 assert.equal(lost?.exitCode,3);assert.equal(lost.details.report.kind,'write_uncertain');assert.equal(u.writes(),1,'not retried');
}
{
 // the identity write is two writes (R2 object, then D1 row): an interruption between them is reported with both sides, never retried, and a later attempt is refused by design
 const d=fakeD1(),store=bucket();
 await live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:d.fetchImpl,store});
 const lost=fakeD1();void lost;
 const cutting=async(url,init={})=>{const body=init.body?JSON.parse(init.body):null;if(body?.sql&&/INSERT INTO epg_diagnostic_identity/.test(body.sql))throw new Error('connection reset');return d.fetchImpl(url,init);};
 const split=await failure(()=>live.run({command:'identity',apply:true,confirm:live.CONFIRM.identity,env:env(),fetchImpl:cutting,store}));
 assert.equal(split?.exitCode,3);assert.equal(split.details.report.identity,'interrupted');assert.deepEqual(split.details.report.sides,{r2:'present',d1:'absent'});assert.match(split.message,/do not retry/);
 const inserts=d.log.filter(entry=>/INSERT INTO epg_diagnostic_identity/.test(entry.sql||'')).length;assert.equal(inserts,0,'the interrupted insert never reached the database and was not repeated');
 const retry=await failure(()=>live.run({command:'identity',apply:true,confirm:live.CONFIRM.identity,env:env(),fetchImpl:d.fetchImpl,store}));
 assert.equal(retry?.exitCode,3);assert.match(retry.message,/domain_not_empty/,'a retry is refused: the bucket is no longer empty');assert.equal(sqlRows(d.file,'SELECT count(*) AS n FROM epg_diagnostic_identity')[0].n,0,'and nothing was inserted by hand');
}
{
 // identity refuses a used bucket and a used database, and writes nothing
 const d=fakeD1(),store=bucket();
 await live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:d.fetchImpl,store});
 await store.put('epg/generation.json','{}');
 const usedBucket=await failure(()=>live.run({...{command:'identity',apply:true,confirm:live.CONFIRM.identity},env:env(),fetchImpl:d.fetchImpl,store}));
 assert.equal(usedBucket?.exitCode,3);assert.match(usedBucket.message,/domain_not_empty/);assert.equal(store.objects.has('diagnostic/identity.json'),false);
 await store.delete('epg/generation.json');
 sqliteSync([d.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{}',1,'t')"],{encoding:'utf8'});
 const usedDatabase=await failure(()=>live.run({command:'identity',apply:true,confirm:live.CONFIRM.identity,env:env(),fetchImpl:d.fetchImpl,store}));
 assert.equal(usedDatabase?.exitCode,3);assert.match(usedDatabase.message,/domain_not_empty|seed_mismatch/);assert.equal(store.objects.size,0);
 assert.equal(sqlRows(d.file,'SELECT count(*) AS n FROM epg_diagnostic_identity')[0].n,0,'no identity row either');
}
{
 // static: the script has no path to production and no delete, and the Worker bundle does not include it
 assert.doesNotMatch(SOURCE,/\bDELETE FROM\b|\bDROP TABLE\b|\bTRUNCATE\b/i,'the script never deletes data');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('epg-diagnostic-provision'),'an operator script is not part of the Worker bundle');
}

// ---- 7: mutation checks ---------------------------------------------------------------------------------------------------------------------------------------------------------------
{
 const mutants=[
  ['the production database id is allowed',"if(databaseId===PRODUCTION.databaseId)throw new ProvisionError('The production database is refused',3);\n",'','the production database id is refused'],
  ['the bucket is not restricted',"if(bucket===PRODUCTION.bucket)throw new ProvisionError('The production bucket is refused',3);\n if(bucket!==NAMES.bucket)fail('EPG_DIAGNOSTIC_R2_BUCKET can only name '+NAMES.bucket);\n",'','the production bucket is refused'],
  ['the database name is not checked',"if(live.name!==NAMES.database)throw new ProvisionError('The database name must read back as '+NAMES.database,3,{name:live.name});\n",'','the database name must be the diagnostic one'],
  ['the database uuid is not compared',"if(live.uuid!==config.databaseId)throw new ProvisionError('The database read back is not the configured one',3);\n",'','the database uuid read back must match'],
  ['apply needs no confirmation'," if(apply&&confirm!==CONFIRM[command])throw new ProvisionError('--apply needs --confirm '+CONFIRM[command],2);\n",'','apply needs its confirmation'],
  ['schema ignores a used database',"if(report.database.tables!==0)throw new ProvisionError('The diagnostic database already has tables; the schema is applied only to an empty one',3,{report});\n",'','schema refuses a database with tables'],
  ['the bucket handle writes any key',"if(key!==IDENTITY_OBJECT)throw new ProvisionError('Write refused: only '+IDENTITY_OBJECT+' may be written',3);\n",'','the bucket handle writes only the identity object'],
 ['a malformed read is taken as empty',"if(!only||only.success!==true||!Array.isArray(only.results))throw new ProvisionError('A read response did not prove its result; the state is unknown, not empty',3,{kind:'malformed_read'});\n  return only.results;","return only?.results||[];",'a malformed read does not prove an empty database'],
  ['an arbitrary endpoint is trusted'," if(url.protocol==='https:'&&value===canonical)return value;\n throw new ProvisionError(label+' must be the canonical Cloudflare endpoint or a loopback test server',2);\n"," return value;\n",'an arbitrary endpoint is refused before any request'],
 ];
 for(const [name,from,to,concern] of mutants){
  assert.equal(SOURCE.split(from).length-1,1,'the mutant pattern exists once: '+name);
  const file=path.join(path.dirname(SCRIPT),'epg-diagnostic-provision.mutant-'+(counter++)+'.mjs');
  fs.writeFileSync(file,SOURCE.replace(from,to));
  try{
   const api=await import(pathToFileURL(file).href+'?m='+counter);
   const results=await scenarios(api);
   assert.equal(results[concern],false,'the checks catch the mutant "'+name+'"');
  }finally{fs.rmSync(file,{force:true});}
 }
}
console.log('EPG diagnostic provision operator: production database and bucket refused, target read back, dry runs and check write nothing, apply behind its own confirmation, schema only into an empty database and stopped at the first failure without retry, identity through the Worker\'s own judgement with a D1 and R2 readback, the bucket handle writes only the identity, and every guard mutant caught passed');
