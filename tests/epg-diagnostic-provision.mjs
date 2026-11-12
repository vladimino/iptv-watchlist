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
import {bucket,world,bootstrap,commit} from './discovery-bounded-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
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
function fakeD1({name='iptv-epg-diagnostic',uuid=DBID,throwOn=null,readBody=null,template=null}={}){
 const file=path.join(root,'d-'+(counter++)+'.sqlite'),log=[];
 if(template)fs.copyFileSync(template,file);
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
  'the real S3 adapter targets the EU endpoint':async()=>{
   // No injected store: the real signed S3 client runs against a fake fetch, and the outgoing request target is what is checked.
   const d=fakeD1(),s3=[];
   const fetchImpl=async(url,init={})=>{
    const href=String(url);
    if(href.startsWith(BASE))return d.fetchImpl(url,init);
    s3.push({url:href,method:init.method||'GET',auth:String(init.headers?.Authorization||''),body:init.body??null});
    return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',{status:200,headers:{'content-type':'application/xml'}});
   };
   const report=await api.run({command:'check',env:env(),fetchImpl});
   const host=ACCOUNT+'.eu.r2.cloudflarestorage.com';
   return s3.length>=1&&s3.every(request=>{const url=new URL(request.url);return url.protocol==='https:'&&url.host===host&&url.pathname==='/iptv-epg-diagnostic'&&url.searchParams.get('list-type')==='2'&&request.method==='GET'&&request.body===null&&/^AWS4-HMAC-SHA256 Credential=/.test(request.auth)&&request.auth.includes('Credential='+KEY+'/')&&/SignedHeaders=[^,]*\bhost\b/.test(request.auth)&&!request.auth.includes(SECRET);})&&d.writes()===0&&report.writes.r2===0&&report.writes.d1===0;},
  'the real S3 adapter writes the dataset key':async()=>{const r=await realS3();const out=await api.run({command:'dataset-put',apply:true,confirm:api.CONFIRM['dataset-put'],input:built.file,env:env(),fetchImpl:r.fetchImpl});const key='diagnostic/replay/'+built.dataset.digest+'.json';const puts=r.seen.filter(x=>x.method==='PUT');const EU=ACCOUNT+'.eu.r2.cloudflarestorage.com';const c={written:out.dataset.state==='written',onePut:puts.length===1,key:puts[0]?.key===key,host:puts[0]?.host===EU,bucket:puts[0]?.bucket==='iptv-epg-diagnostic',ifNoneMatch:puts[0]?.ifNoneMatch==='*',contentType:puts[0]?.contentType==='application/json',body:puts[0]?.body===datasetText,signed:/SignedHeaders=[^,]*\bhost\b/.test(puts[0]?.auth||''),onlyEu:r.seen.every(x=>x.host===EU&&x.method!=='DELETE'),stored:r.objects.get(key)===datasetText};if(process.env.DEBUG_SCENARIOS)console.error('S3',JSON.stringify(c));return Object.values(c).every(Boolean);},
 'a symlink into the repository is refused':async()=>{const leak=path.resolve('tests/private-out');fs.rmSync(leak,{recursive:true,force:true});try{const a=await failure(()=>api.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(dirLink,'private-out'),generation:sourceId,confirm:api.CONFIRM['dataset-build'],now:FIXED}));const {d,store}=await provisioned();const b=await failure(()=>api.run({command:'dataset-put',confirm:api.CONFIRM['dataset-put'],input:fileLink,env:env(),fetchImpl:d.fetchImpl,store}));return a?.exitCode===2&&b?.exitCode===2&&!fs.existsSync(leak);}finally{fs.rmSync(leak,{recursive:true,force:true});}},
 'a concurrent transfer change does not move the authority':async()=>{const {d,store}=await provisioned();const racing=async(url,init={})=>{const body=init.body?JSON.parse(init.body):null;if(body?.sql&&/^UPDATE discovery_authority/.test(body.sql))sqliteSync([d.file,"UPDATE discovery_transfer SET state='loading' WHERE id=1"],{encoding:'utf8'});return d.fetchImpl(url,init);};const e=await failure(()=>api.run({command:'prepare-domain',apply:true,confirm:api.CONFIRM['prepare-domain'],env:env(),fetchImpl:racing,store}));return e?.exitCode===3&&sqlRows(d.file,'SELECT mode FROM discovery_authority')[0].mode==='r2';},
 'prepare-domain needs the identity':async()=>{const d=fakeD1({template:tplD.file}),store=bucket();const e=await failure(()=>api.run({command:'prepare-domain',apply:true,confirm:api.CONFIRM['prepare-domain'],env:env(),fetchImpl:d.fetchImpl,store}));return e?.exitCode===3&&sqlRows(d.file,'SELECT mode FROM discovery_authority')[0].mode==='r2';},
 'dataset-put verifies the dataset':async()=>{const {d,store}=await provisioned();const e=await failure(()=>api.run({command:'dataset-put',apply:true,confirm:api.CONFIRM['dataset-put'],input:tamperedFile,env:env(),fetchImpl:d.fetchImpl,store}));return e?.exitCode===3&&[...store.objects.keys()].join()==='diagnostic/identity.json';},
 'the dataset key is the only extra write':async()=>{const store=bucket();const plain=api.guardedBucket(store);const wide=api.guardedBucket(store,{datasetWrites:true});const key='diagnostic/replay/'+'a'.repeat(64)+'.json';const a=await failure(()=>plain.put(key,'{}',{onlyIf:{etagDoesNotMatch:'*'}}));const b=await failure(()=>wide.put('epg/generation.json','{}',{onlyIf:{etagDoesNotMatch:'*'}}));const c=await failure(()=>wide.put('diagnostic/replay/short.json','{}',{onlyIf:{etagDoesNotMatch:'*'}}));await wide.put(key,'{}',{onlyIf:{etagDoesNotMatch:'*'}});return !!a&&!!b&&!!c&&[...store.objects.keys()].join()===key;},
 'the bucket handle writes only the identity object':async()=>{const store=bucket();const guarded=api.guardedBucket(store);const a=await failure(()=>guarded.put('epg/generation.json','{}',{onlyIf:{etagDoesNotMatch:'*'}}));const b=await failure(()=>guarded.delete('diagnostic/identity.json'));return !!a&&!!b&&store.objects.size===0;},
 };
 for(const [name,run] of Object.entries(checks)){try{results[name]=(await run())===true;}catch(error){if(process.env.DEBUG_SCENARIOS)console.error(name,error?.message,JSON.stringify(error?.details||null));results[name]=false;}}
 return results;
}

const live=await import(pathToFileURL(SCRIPT).href);
// A provisioned diagnostic domain (schema and identity) built once and copied per use, and a real replay dataset built by the script from the stored state of a bounded-ledger world.
const tplD=fakeD1(),tplStore=bucket();
await live.run({command:'schema',apply:true,confirm:live.CONFIRM.schema,env:env(),fetchImpl:tplD.fetchImpl,store:tplStore});
await live.run({command:'identity',apply:true,confirm:live.CONFIRM.identity,env:env(),fetchImpl:tplD.fetchImpl,store:tplStore});
const identityText=tplStore.objects.get('diagnostic/identity.json').bytes.toString('utf8');
const provisioned=async()=>{const d=fakeD1({template:tplD.file});const store=bucket();await store.put('diagnostic/identity.json',identityText,{onlyIf:{etagDoesNotMatch:'*'}});return {d,store};};
// The REAL signed S3 client against a fake S3 over a Map (path-style, EU endpoint of the account), with a fake D1 beside it: every request is recorded.
const realS3=async()=>{
 const {d}=await provisioned();
 const objects=new Map([['diagnostic/identity.json',identityText]]),seen=[];
 const etagOf=key=>'"e-'+key.length+'-'+objects.get(key).length+'"';
 const fetchImpl=async(url,init={})=>{
  const href=String(url);
  if(href.startsWith(BASE))return d.fetchImpl(url,init);
  const target=new URL(href),method=init.method||'GET';
  const parts=target.pathname.split('/').filter(Boolean).map(decodeURIComponent),key=parts.slice(1).join('/');
  const body=init.body==null?null:Buffer.from(init.body).toString('utf8');
  seen.push({method,host:target.host,bucket:parts[0],key,ifNoneMatch:init.headers?.['if-none-match']??null,contentType:init.headers?.['content-type']??null,auth:String(init.headers?.Authorization||''),body});
  const reply=(status,text='',headers={})=>new Response(text,{status,headers});
  if(!key){const contents=[...objects].map(([k,v])=>'<Contents><Key>'+k+'</Key><Size>'+Buffer.byteLength(v)+'</Size><ETag>'+etagOf(k)+'</ETag><LastModified>2026-11-12T00:00:00.000Z</LastModified></Contents>').join('');return reply(200,'<ListBucketResult><IsTruncated>false</IsTruncated>'+contents+'</ListBucketResult>');}
  if(method==='GET'||method==='HEAD'){if(!objects.has(key))return reply(404);return reply(200,method==='GET'?objects.get(key):'',{etag:etagOf(key),'content-length':String(Buffer.byteLength(objects.get(key)))});}
  if(method==='PUT'){if(init.headers?.['if-none-match']==='*'&&objects.has(key))return reply(412);objects.set(key,body);return reply(200,'',{etag:etagOf(key)});}
  throw new Error('unexpected S3 request '+method);
 };
 return {d,objects,seen,fetchImpl};
};
const linkRoot=path.join(root,'links');fs.mkdirSync(linkRoot,{recursive:true});
const dirLink=path.join(linkRoot,'to-repo-tests'),fileLink=path.join(linkRoot,'to-repo-file.json');
fs.symlinkSync(path.resolve('tests'),dirLink,'dir');fs.symlinkSync(path.resolve('package.json'),fileLink);
const sourceWorld=world();await bootstrap(sourceWorld,0);for(const day of [1,2,3,4,5,6])await commit(sourceWorld,day,'bounded');
const sourceId=sourceWorld.published.programmeRunId;
const privateRoot=path.join(root,'private');
const FIXED=()=>new Date('2026-11-12T12:00:00Z');
const BUILD_CONFIRM=live.CONFIRM['dataset-build'];
const PROD_KEY='prod-read-key-ID',PROD_SECRET='prod-read-SECRET-value';
const prodEnv=(extra={})=>env({R2_SNAPSHOT_ACCESS_KEY_ID:PROD_KEY,R2_SNAPSHOT_SECRET_ACCESS_KEY:PROD_SECRET,...extra});
const built=await live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'a'),generation:sourceId,confirm:BUILD_CONFIRM,now:FIXED});
const datasetText=fs.readFileSync(built.file,'utf8');
const tamperedText=(()=>{const x=JSON.parse(datasetText);x.baseline.items[0].title=String(x.baseline.items[0].title).split('').reverse().join('')+'!';return JSON.stringify(x);})();
const tamperedFile=path.join(privateRoot,'tampered.json');fs.writeFileSync(tamperedFile,tamperedText,{mode:0o600});

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

// ---- H2: dataset-build, prepare-domain and dataset-put ----------------------------------------------------------------------------------------------------------------------------
{
 // dataset-build reads the production store and writes nothing to it; the report has no payload; the file is private; the same stored state and time give the same digest
 assert.equal(built.command,'dataset-build');assert.deepEqual(built.writes,{cloudflare:0});assert.equal(built.source.bucket,'iptv');assert.equal(built.source.programmeRunId,sourceId);
 assert.equal(fs.statSync(built.file).mode&0o777,0o600,'a private file');assert.equal(path.basename(built.file),'epg-replay-'+built.dataset.digest+'.json');
 const Replay=live.loadReplay();assert.equal((await Replay.verifyDataset(JSON.parse(datasetText),{expectedDigest:built.dataset.digest,expectedProgrammeRunId:sourceId})).ok,true);
 assert.equal(built.dataset.fidelity.level,'reduced');for(const word of ['Сталкер','Солярис','Зеркало'])assert.ok(!JSON.stringify(built).includes(word),'no payload in the report');
 const putsBefore=sourceWorld.bkt.puts.length;
 const again=await live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'b'),generation:sourceId,confirm:BUILD_CONFIRM,now:FIXED});
 assert.equal(again.dataset.digest,built.dataset.digest,'deterministic');assert.equal(sourceWorld.bkt.puts.length,putsBefore,'the production store was only read');
 // the pointer names the generation when none is given; an unpublished or absent pointer, an unknown generation, a missing confirmation and a path in the repository or a relative one are refused
 await sourceWorld.bkt.put('epg/published-generation.json',JSON.stringify({programmeRunId:sourceId,phase:'published'}));
 const viaPointer=await live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'c'),confirm:BUILD_CONFIRM,now:FIXED});assert.equal(viaPointer.dataset.digest,built.dataset.digest);
 await sourceWorld.bkt.put('epg/published-generation.json',JSON.stringify({programmeRunId:sourceId,phase:'staging'}));
 assert.equal((await failure(()=>live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'d'),confirm:BUILD_CONFIRM,now:FIXED})))?.exitCode,3,'an unpublished pointer');
 assert.equal((await failure(()=>live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'e'),generation:'ffffffff-ffff-4fff-8fff-ffffffffffff',confirm:BUILD_CONFIRM,now:FIXED})))?.exitCode,3,'an unknown generation');
 assert.equal((await failure(()=>live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'f'),generation:sourceId,confirm:null})))?.exitCode,2,'no confirmation');
 assert.equal((await failure(()=>live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.resolve('tests/private-dataset'),generation:sourceId,confirm:BUILD_CONFIRM,now:FIXED})))?.exitCode,2,'inside the repository');
 assert.equal((await failure(()=>live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:'relative/dir',generation:sourceId,confirm:BUILD_CONFIRM,now:FIXED})))?.exitCode,2,'relative path');
 assert.equal((await failure(()=>live.buildDataset({env:prodEnv(),store:sourceWorld.bkt,output:path.join(privateRoot,'a'),generation:sourceId,confirm:BUILD_CONFIRM,now:FIXED})))?.exitCode===3,true,'an existing file is never overwritten');
 // the real S3 client reads the PRODUCTION bucket on the account's default endpoint, GET only, signed with the read-only key, and nothing is sent anywhere else
 const seen=[];
 const fetchImpl=async(url,init={})=>{seen.push({url:String(url),method:init.method||'GET',auth:String(init.headers?.Authorization||''),body:init.body??null});return new Response('',{status:404});};
 const missing=await failure(()=>live.buildDataset({env:prodEnv(),fetchImpl,output:path.join(privateRoot,'g'),confirm:BUILD_CONFIRM,now:FIXED}));
 assert.equal(missing?.exitCode,3);assert.equal(seen.length,1);
 const target=new URL(seen[0].url);assert.equal(target.host,ACCOUNT+'.r2.cloudflarestorage.com');assert.equal(target.pathname,'/iptv/epg/published-generation.json');assert.equal(seen[0].method,'GET');assert.equal(seen[0].body,null);
 assert.ok(seen[0].auth.includes('Credential='+PROD_KEY+'/')&&/SignedHeaders=[^,]*\bhost\b/.test(seen[0].auth)&&!seen[0].auth.includes(PROD_SECRET));
 const arbitrary=await failure(()=>live.buildDataset({env:prodEnv({EPG_DIAGNOSTIC_PRODUCTION_R2_ENDPOINT:'https://arbitrary-host.example'}),fetchImpl:async()=>{throw new Error('no request');},output:path.join(privateRoot,'h'),confirm:BUILD_CONFIRM}));
 assert.equal(arbitrary?.exitCode,2,'a credential never goes to an arbitrary host');
 assert.equal((await failure(()=>live.buildDataset({env:env(),store:sourceWorld.bkt,output:path.join(privateRoot,'i'),generation:sourceId,confirm:BUILD_CONFIRM})))?.exitCode,2,'the production read key is required');
}
{
 // prepare-domain: only on a domain that carries its identity, only from the seeded state, exactly one guarded statement, read back
 const {d,store}=await provisioned();
 const mode=()=>sqlRows(d.file,'SELECT mode, cutover, generation FROM discovery_authority')[0];
 assert.deepEqual(mode(),{mode:'r2',cutover:'open',generation:0});
 const noConfirm=await failure(()=>live.run({command:'prepare-domain',apply:true,confirm:null,env:env(),fetchImpl:d.fetchImpl,store}));assert.equal(noConfirm?.exitCode,2);
 const dry=await live.run({command:'prepare-domain',env:env(),fetchImpl:d.fetchImpl,store});
 assert.equal(dry.prepared,'would_write');assert.equal(dry.discoveryAuthority.before.mode,'r2');assert.deepEqual(dry.writes,{d1:0,r2:0});assert.equal(mode().mode,'r2');
 const before=d.writes();
 const done=await live.run({command:'prepare-domain',apply:true,confirm:live.CONFIRM['prepare-domain'],env:env(),fetchImpl:d.fetchImpl,store});
 assert.equal(done.prepared,'written');assert.equal(done.discoveryAuthority.after.mode,'d1');assert.equal(done.discoveryAuthority.after.cutover,'open');assert.equal(d.writes()-before,1,'one statement');
 assert.deepEqual(mode(),{mode:'d1',cutover:'open',generation:0});
 const repeat=await live.run({command:'prepare-domain',apply:true,confirm:live.CONFIRM['prepare-domain'],env:env(),fetchImpl:d.fetchImpl,store});
 assert.equal(repeat.prepared,'already');assert.equal(d.writes()-before,1,'a second apply writes nothing');
 const checked=await live.run({command:'check',env:env(),fetchImpl:d.fetchImpl,store});assert.equal(checked.discoveryAuthority.mode,'d1');
 // a domain that has moved on (a generation, a programme, a transfer) is not touched
 const moved=await provisioned();
 sqliteSync([moved.d.file,"UPDATE discovery_authority SET generation=5 WHERE id=1"],{encoding:'utf8'});
 const refused=await failure(()=>live.run({command:'prepare-domain',apply:true,confirm:live.CONFIRM['prepare-domain'],env:env(),fetchImpl:moved.d.fetchImpl,store:moved.store}));
 assert.equal(refused?.exitCode,3);assert.equal(sqlRows(moved.d.file,'SELECT mode FROM discovery_authority')[0].mode,'r2');assert.equal(moved.d.writes(),0);
 // the identity must be in both places
 const noObject=await provisioned();await noObject.store.delete('diagnostic/identity.json');
 assert.equal((await failure(()=>live.run({command:'prepare-domain',apply:true,confirm:live.CONFIRM['prepare-domain'],env:env(),fetchImpl:noObject.d.fetchImpl,store:noObject.store})))?.exitCode,3);
 // with the REAL Discovery authority reading the marker: ready only after the preparation (the same gate the run asks)
 const Authority=await import('../src/discovery-authority.js');
 const asEnv=file=>({DB:d1Standin(file,{maxBinds:100})});
 assert.equal((await Authority.readAuthority(asEnv(moved.d.file))).ready,false,'the seeded marker is not ready');
 assert.equal((await Authority.readAuthority(asEnv(d.file))).ready,true,'the prepared marker is the production state');
}
{
 // dataset-put: only on a domain with its identity; verified before it is written; create-only; read back; the same file twice is a no-op; a different content under the same key is never overwritten
 const {d,store}=await provisioned();
 const args=(extra={})=>({command:'dataset-put',confirm:live.CONFIRM['dataset-put'],input:built.file,env:env(),fetchImpl:d.fetchImpl,store,...extra});
 const noConfirm=await failure(()=>live.run(args({apply:true,confirm:null})));assert.equal(noConfirm?.exitCode,2);
 const dry=await live.run(args());
 assert.equal(dry.dataset.state,'would_write');assert.equal(dry.dataset.key,'diagnostic/replay/'+built.dataset.digest+'.json');assert.deepEqual(dry.writes,{d1:0,r2:0});assert.deepEqual([...store.objects.keys()],['diagnostic/identity.json']);
 assert.ok(!JSON.stringify(dry).includes('Сталкер'),'no payload in the report');
 const tampered=await failure(()=>live.run(args({apply:true,input:tamperedFile})));assert.equal(tampered?.exitCode,3);assert.match(tampered.message,/does not verify/);assert.deepEqual([...store.objects.keys()],['diagnostic/identity.json']);
 const inRepo=await failure(()=>live.run(args({apply:true,input:path.resolve('package.json')})));assert.equal(inRepo?.exitCode,2);
 const written=await live.run(args({apply:true}));
 assert.equal(written.dataset.state,'written');assert.deepEqual(written.writes.r2,1);assert.deepEqual([...store.objects.keys()].sort(),['diagnostic/identity.json','diagnostic/replay/'+built.dataset.digest+'.json'].sort());
 assert.equal(store.objects.get('diagnostic/replay/'+built.dataset.digest+'.json').bytes.toString('utf8'),datasetText,'byte for byte the file');
 const second=await live.run(args({apply:true}));assert.equal(second.dataset.state,'already_present');assert.equal(second.writes.r2,0);
 // a different content under the same key is never overwritten
 store.objects.set('diagnostic/replay/'+built.dataset.digest+'.json',{bytes:Buffer.from('{}'),etag:'x'});
 const clash=await failure(()=>live.run(args({apply:true})));assert.equal(clash?.exitCode,3);assert.equal(store.objects.get('diagnostic/replay/'+built.dataset.digest+'.json').bytes.toString('utf8'),'{}');
 // no identity, no dataset
 const bare=await provisioned();await bare.store.delete('diagnostic/identity.json');
 assert.equal((await failure(()=>live.run({command:'dataset-put',apply:true,confirm:live.CONFIRM['dataset-put'],input:built.file,env:env(),fetchImpl:bare.d.fetchImpl,store:bare.store})))?.exitCode,3);
 // the Worker's own loader accepts what the operator wrote (the run reads `diagnostic/replay/<digest>.json` and verifies it)
 const Replay=live.loadReplay();const stored=await (await (await provisioned()).store.get('diagnostic/identity.json')).json();void stored;
 assert.equal((await Replay.verifyDataset(JSON.parse(datasetText),{expectedDigest:built.dataset.digest})).ok,true);
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
  ['the bucket handle writes any key',"if(!allowed(key))throw new ProvisionError('Write refused: '+key+' is not a key this command may write',3);\n",'','the bucket handle writes only the identity object'],
 ['a malformed read is taken as empty',"if(!only||only.success!==true||!Array.isArray(only.results))throw new ProvisionError('A read response did not prove its result; the state is unknown, not empty',3,{kind:'malformed_read'});\n  return only.results;","return only?.results||[];",'a malformed read does not prove an empty database'],
  ['the S3 adapter is not given the EU endpoint',",R2_SNAPSHOT_ENDPOINT:config.r2Endpoint",'','the real S3 adapter targets the EU endpoint'],
  ['the lower store never learns the dataset key'," if(apply)s3Allowed.add(key);\n",'','the real S3 adapter writes the dataset key'],
  ['containment is lexical',"const resolved=realResolve(target),repo=realResolve(REPO);","const resolved=path.resolve(target),repo=REPO;",'a symlink into the repository is refused'],
  ['the transfer predicate is dropped'," AND EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state='idle')",'','a concurrent transfer change does not move the authority'],
  ['prepare-domain skips the identity check',"async function prepareDomain({d1,bucket,Diag,config,report,apply}){\n await verifyIdentity(d1,bucket,Diag,config);\n","async function prepareDomain({d1,bucket,Diag,config,report,apply}){\n",'prepare-domain needs the identity'],
  ['dataset-put skips the verification'," if(!checked.ok)throw new ProvisionError('The dataset does not verify: '+checked.problems.join(','),3,{problems:checked.problems});\n const key="," const key=",'dataset-put verifies the dataset'],
  ['every command may write the dataset key',"const allowed=key=>key===IDENTITY_OBJECT||(datasetWrites&&DATASET_KEY.test(key));","const allowed=key=>key===IDENTITY_OBJECT||DATASET_KEY.test(key);",'the dataset key is the only extra write'],
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
